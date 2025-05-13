import fs from 'fs';
import path from 'path';
import child_process from 'child_process';

export function importJSON(m: string) {
	return JSON.parse(fs.readFileSync(m, { encoding: 'utf-8' }));
}

export function fsLog(path: string, data: string) {
	fs.appendFileSync(path, data);
}

export function shell(cmd: string, cwd?: string): Promise<{
	error: child_process.ExecException | null, stdout: string, stderr: string
}> {
	return new Promise((res) => {
		child_process.exec(cmd, { cwd }, (error, stdout, stderr) => {
			res({ error, stdout, stderr });
		});
	});
}

export interface Auth {
	name: string,
	pass: string
}

export interface Services {
	BattleFactory?: import('./BattleFactory').default
}

/**
 * Resolved with the matching message.
 * Rejected with PredicateRejection with the matching message.
 * 
 * true:resolve, null:ignore, false:reject
 */
export type Predicate = (msg: string) => boolean | null;

export type PredicateVar = (...val: string[]) => Predicate;

export type Problems = string[];

export enum LogSign {
	IN = '<<',
	OUT = '>>',
	INFO = '::',
	WARN = '!!',
	ERR = 'XX'
}

export enum State {
	NEW = 0,
	INIT = 1,
	ON = 2,
	OFF = 3
}

/* export enum RejectReason {
	TIMEOUT = 'Timed out.',
	DISCONNECT = 'Disconnected.'
} */

/** Thrown when a predicate returns false. */
export class PredicateRejection extends Error {

	readonly description?: string;

	constructor(message: string, description?: string) {
		super(message);
		this.description = description;
	}

}

/** Thrown when a predicate times out. */
export class TimeoutRejection extends Error {

	readonly description?: string;

	constructor(description?: string) {
		super();
		this.description = description;
	}

}

/** Thrown when shutdown before a predicate settles. */
export class ShutdownRejection extends Error {

	constructor() {
		super();
	}

}

export type PokemonStat = 'hp' | 'atk' | 'def' | 'spa' | 'spd' | 'spe';

export interface FactorySet {
	species: string,
	item: string[],
	ability: string[],
	gender: string,
	nature: string[],
	evs: { [k in PokemonStat]: number },
	ivs: { [k in PokemonStat]: number },
	moves: string[][],
	teraType: string,
	weight: number
}

export const PATH_CRASHLOG = path.join(import.meta.dirname, '..', 'crash.log');
export const PATH_MISCLOG = path.join(import.meta.dirname, '..', 'misc.log');

export const PATH_CONFIG = path.join(import.meta.dirname, '..', 'config.json');

export const PATH_PS_INDEX = path.join(import.meta.dirname, '..', '..', 'pokemon-showdown', 'dist', 'sim', 'index.js');

export const PATH_PS_FACTORYSETS = path.join(
	import.meta.dirname, '..', '..', 'pokemon-showdown', 'dist', 'data', 'random-battles', 'gen9', 'factory-sets.json'
);
