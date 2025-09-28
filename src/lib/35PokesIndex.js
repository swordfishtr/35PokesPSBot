/**
 * Adapted from the 35 Pokes browser extension.
 * https://github.com/swordfishtr/35PokesExtension
 */

"use strict";
import fs from "fs";
import path from 'path';
import { parseTar } from "./nanotar.js";

export const PATH_35_INDEX = path.join(import.meta.dirname, '..', '..', 'data', 'metagames.json');
export const PATH_35_FACTORYSETS = path.join(import.meta.dirname, '..', '..', 'data', 'factory-sets.json');

export const index = {};

try { await checkUpdates(); }
catch {}

export function checkUpdates() {
	const REPO_INFO = "https://api.github.com/repos/swordfishtr/35PokesIndex";
	const REPO_TARGZ = "https://api.github.com/repos/swordfishtr/35PokesIndex/tarball/main";
	//const REPO_TARGZ = "https://api.github.com/repos/swordfishtr/35PokesIndex/tarball/next";

	let local = null;
	try { local = JSON.parse(fs.readFileSync(PATH_35_INDEX, { encoding: 'utf-8' })); }
	catch {}

	return fetch(REPO_INFO)
	.then((info) => {
		if(!info.ok) throw new Error("35Pokes Background: Failed to fetch repository metadata.");
		return info.json();
	})
	.then((json) => {
		delete index.timestamp;
		delete index.metagames;
		if(local && local.timestamp === json.pushed_at) {
			// We're up to date.
			index.timestamp = local.timestamp;
			index.metagames = local.metagames;
			console.log('Metagames: Up to date.');
			throw 0;
		}
		index.timestamp = json.pushed_at;
		index.metagames = {};
		console.log('Metagames: Updating.');
		return fetch(REPO_TARGZ);
	})
	.then((repo) => {
		if(!repo.ok) throw new Error("35Pokes Background: Failed to fetch repository metadata.");
		return repo.body.pipeThrough(new DecompressionStream("gzip"));
	})
	.then((stream) => new Response(stream).arrayBuffer())
	.then((data) => parseTar(data))
	.then((tar) => {
		const td = new TextDecoder("utf-8");
		const nameDir = /^[^/]+\/([^/]+)\/$/;
		const nameFile = /^[^/]+\/([^/]+\/[^/]+?)\s*$/;
		const nameFactorySets = /^[^/]+\/factory-sets.json$/;

		delete tar[0];
		delete tar[1];

		tar.forEach((file, i) => {
			if(file.type === "file") {
				const name = nameFile.exec(file.name)?.[1];
				if(name) {
					file.name = name;
					file.data = td.decode(file.data);
				}
				else {
					if(nameFactorySets.test(file.name)) {
						fs.writeFileSync(PATH_35_FACTORYSETS, td.decode(file.data));
					}
					delete tar[i];
				}
			}
			else if(file.type === "directory") {
				const name = nameDir.exec(file.name)?.[1];
				if(name) index.metagames[name] = {};
				delete tar[i];
			}
			else {
				console.warn("35Pokes Background: Unknown file type:", file.type);
				delete tar[i];
			}
		});

		const parentFind = /parent:\s*(.+?)\s*(?:;|$)/m;

		tar.forEach((file) => {
			const parentName = parentFind.exec(file.data)?.[1];
			const [sGroup, sName] = file.name.split("/");

			// This metagame has no parent; parse right away.
			if(!parentName) {
				console.info("35Pokes Background: Depth 1:", file.name);
				index.metagames[sGroup][sName] = parseMeta(file.data, sGroup);
				if(file.dependants) file.dependants.forEach((f) => f(index.metagames[sGroup][sName]));
				return;
			}

			// This metagame has a parent, check that it exists.
			const parentRef = tar.find((f) => f?.name === parentName);
			if(!parentRef) {
				console.warn("35Pokes Background: Missing parent:", parentName);
				return;
			}
			const [pGroup, pName] = parentName.split("/");

			// This metagame's parent has already been parsed; parse right away.
			if(index.metagames[pGroup]?.[pName]) {
				console.info("35Pokes Background: Depth 2:", file.name);
				index.metagames[sGroup][sName] = parseMeta(file.data, sGroup, index.metagames[pGroup][pName]);
				if(file.dependants) file.dependants.forEach((f) => f(index.metagames[sGroup][sName]));
				return;
			}

			// This metagame's parent has not been parsed yet. Give the parent a callback to parse this metagame when that is done.
			if(!parentRef.dependants) parentRef.dependants = [];
			console.info("35Pokes Background: Depth 3:", file.name);
			parentRef.dependants.push((ref) => {
				index.metagames[sGroup][sName] = parseMeta(file.data, sGroup, ref);
				if(file.dependants) file.dependants.forEach((f) => f(index.metagames[sGroup][sName]));
			});
		});

		fs.writeFileSync(PATH_35_INDEX, JSON.stringify(index));
		console.log('Metagames: Done.');
	})
	.catch((err) => {
		if(err !== 0) throw err;
	});
}

/**
 * @param {string} txt  - metagame to be interpreted.
 * @param {string} group  - group to desplay before name in the top header. (there's no pretty way to handle this)
 * @param {{}[]} [parent] - reference to interpreted parent metagame.
 * @returns {{}[]} - interpreted metagame.
 */
function parseMeta(txt, group, parent) {
	const metagame = structuredClone(parent) ?? [{}];

	// Capture the next line that has content.
	const lines = /^(.+)$/gm;

	// Match if first non-whitespace character is #
	const isComment = /^\s*#/;

	// Expect the mandatory data at the top - currently only the display name.
	while(true) {
		const line = lines.exec(txt)?.[1];

		// We've reached the end already. This means the file was a nothing burger.
		if(!line) return metagame;

		if(isComment.test(line)) continue;

		// For popup.
		metagame[0].name = line;

		// The first element of a metagame doubles up as a rules container and the top header.
		// Avoid displaying something like "2024 Nov 2024"
		metagame[0].value = `35 Pokes: ${line.includes(group)?"":group+" "} ${line}`;
		metagame[0].header = true;

		break;
	}

	// Everything else is optional and can be in any order.

	const isCode = /^\s*code:\s*(.*?)\s*$/i;
	const isRules = /^\s*rules;/i;
	const modGen = /;\s*generation:\s*(.+?)(?:$|[;\s])/i;
	const modOldGen = /;\s*oldgen:\s*(.+?)(?:$|[;\s])/i;
	const modFlipped = /;\s*flipped(?:$|[;\s])/i;
	const modScalemons = /;\s*scalemons(?:$|[;\s])/i;
	const modMoves = /;\s*moves(?:$|[;\s])/i;
	const isHeader = /;\s*header\s*(?:;|$)/i;
	const isParent = /^\s*parent:/i;
	const dataValueBase = /^\s*(.*?)\s*(?:;|$)/;
	const dataValueChild = /^\s*([+-])\s*(.*?)\s*(?:;|$)/;
	const pkmnMoves = /;\s*moves:(.+?);/i;
	const pkmnMoveLoop = /([+-])\s*(.+?)\s*(?:,|$)/g;

	// split into a loop, like moves?
	const pkmnAbils = /;\s*abilities:(?:\s*1\s*:\s*(.*?)\s*(?:$|[,;]))?(?:(?<!;\s*)\s*2\s*:\s*(.*?)\s*(?:$|[,;]))?(?:(?<!;\s*)\s*3\s*:\s*(.*?)\s*(?:$|[,;]))?(?:(?<!;\s*)\s*4\s*:\s*(.*?)\s*(?:$|[,;]))?/i;

	while(true) {
		const line = lines.exec(txt)?.[1];

		// End of file
		if(!line) break;

		if(isComment.test(line)) continue;
		
		const code = isCode.exec(line)?.[1];
		if(code) {
			metagame[0].code = code;
			continue;
		}

		if(isRules.test(line)) {
			if(!metagame[0].mods) metagame[0].mods = [];

			const generation = modGen.exec(line)?.[1];
			if(generation) metagame[0].generation = generation;

			const oldgen = modOldGen.exec(line)?.[1];
			if(oldgen) metagame[0].oldgen = oldgen;

			if(modFlipped.test(line)) metagame[0].mods.push("flipped");
			if(modScalemons.test(line)) metagame[0].mods.push("scalemons");
			if(modMoves.test(line)) metagame[0].mods.push("moves");

			continue;
		}

		if(isHeader.test(line)) {
			// Always defined, but can be empty string.
			// We'll accept it for headers, reject it for pokemon names below.
			const value = dataValueBase.exec(line)[1];
			metagame.push({ value: value, header: true });
			continue;
		}

		const mon = {};

		if(parent) {
			const value = dataValueChild.exec(line);
			if(!value) {
				if(isParent.test(line)) continue;
				console.warn("35Pokes Background: Parsing child meta: Ignoring invalid line:", line);
				continue;
			}
			if(value[1] === "-") {
				const i = metagame.findLastIndex((mon) => mon.value === value[2]);
				if(i >= 0) metagame.splice(i, 1);
				else console.warn("35Pokes Background: Parsing child meta: Could not remove nonexistent pokemon:", line);
				continue;
			}
			mon.value = value[2];
		}
		else {
			const value = dataValueBase.exec(line)[1];
			if(value === "") {
				console.warn("35Pokes Background: Parsing base meta: Ignoring line with missing value:", line);
				continue;
			}
			mon.value = value;
		}

		const abilities = pkmnAbils.exec(line);
		if(abilities) {
			// Keep as is by default.
			// To delete ability slots, use "abilities:1:,2:,3:,4:;"
			// (whitespace between any of these is ok for this purpose.)
			mon.abilities = [true, true, true, true];
			if(typeof abilities[1] === "string") mon.abilities[0] = abilities[1];
			if(typeof abilities[2] === "string") mon.abilities[1] = abilities[2];
			if(typeof abilities[3] === "string") mon.abilities[2] = abilities[3];
			if(typeof abilities[4] === "string") mon.abilities[3] = abilities[4];
		}

		const moves = pkmnMoves.exec(line)?.[1];
		if(moves) {
			mon.moves = { add: [], ban: [] };
			while(true) {
				const move = pkmnMoveLoop.exec(moves);
				if(!move) break;
				// Use "-all, +move" to set learnset. This is handled in content_main.js
				if(move[1] === "+") mon.moves.add.push(move[2]);
				else mon.moves.ban.push(move[2]);
			}
		}

		metagame.push(mon);
	}

	return metagame;
}
