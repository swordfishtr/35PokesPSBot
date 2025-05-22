/**
 * Dependency Scripts
 * 
 * These functions are responsible for checking and installing
 * external dependencies. They are to be used in Controller
 * such that no check is done more than once.
 * 
 * Specific requirements like moving a file should be done
 * within the service prelaunch().
 */

import fs from 'fs';
import path from 'path';
import { importJSON, PATH_CONFIG, shell } from './globals.js';

// throw for failed dependency checks.
// Cache status in controller.

export function checkInstall35PokesIndex() {
	const DIR_REPOS = path.normalize('../..');
	const SRC_INDEX = 'https://github.com/swordfishtr/35PokesIndex';
	const DIR_INDEX = path.normalize('../../35PokesIndex');

	console.log('Checking availability of 35PokesIndex ...');
	return shell('git remote get-url origin', DIR_INDEX)
	.then((remote) => {
		remote = remote.slice(0, -1);
		console.log(remote);
		if(remote === SRC_INDEX) {
			console.log('Available.');
			return true;
		}
		console.log('Incorrect repository. Deleting and cloning ...');
		return false;
	})
	.catch((e) => {
		if(![128, 'ENOENT'].includes(e.code)) throw e;
		console.log('Unavailable. Cloning ...');
		return false;
	})
	.then((repoExists) => {
		if(!repoExists) {
			fs.rmSync(DIR_INDEX, { recursive: true, force: true });
			return shell(`git clone ${SRC_INDEX}`, DIR_REPOS).then(() => true);
		}
		return false;
	})
	.then((repoIsNew) => {
		if(!repoIsNew) {
			console.log('Checking updates ...');
			return shell('git pull', DIR_INDEX);
		}
	})
	.then(() => {
		console.log('Done.');
	})
}

export function checkInstallPS(skipBuild?: boolean) {
	skipBuild ??= importJSON(PATH_CONFIG).dependencies.skipBuild;
	const DIR_REPOS = path.normalize('../..');
	const DIR_PS = path.normalize('../../pokemon-showdown');
	const SRC_PS = 'https://github.com/smogon/pokemon-showdown';

	console.log('Checking availability of pokemon-showdown ...');
	return shell('git remote get-url origin', DIR_PS)
	.then((remote) => {
		remote = remote.slice(0, -1);
		console.log(remote);
		if(remote === SRC_PS) {
			console.log('Available.');
			return true;
		}
		console.log('Incorrect repository. Deleting and cloning ...');
		return false;
	})
	.catch((e) => {
		if(![128, 'ENOENT'].includes(e.code)) throw e;
		console.log('Unavailable. Cloning ...');
		return false;
	})
	.then((repoExists) => {
		if(!repoExists) {
			fs.rmSync(DIR_PS, { recursive: true, force: true });
			return shell(`git clone ${SRC_PS}`, DIR_REPOS).then(() => true);
		}
		return false;
	})
	.then((repoIsNew) => {
		if(!repoIsNew) {
			console.log('Checking updates ...');
			return shell('git pull', DIR_PS);
		}
	})
	.then(() => {
		if(skipBuild) {
			console.log('Skipping dependency checks ...');
			return;
		}
		console.log('Checking dependencies ...');
		return shell('npm install --omit=optional', DIR_PS);
	})
	.then(() => {
		if(skipBuild) {
			console.log('Skipping build ...');
			return;
		}
		console.log('Running build ...');
		return shell('node build', DIR_PS);
	})
	.then(() => {
		console.log('Done.');
	})
}
