/**
 * Controller, the starting point, responsible for handling services, which use PSBot.
 * 
 * The "server" configuration is used here. Details:
 * enable - whether to serve data from services that opt in.
 * port - system port to listen on, 0 for system, -1 for portEnv.
 * portEnv - environment variable for the port, "" for system.
 * password - if not "", serve only if the request provides password.
 */

import readline from 'readline';
import { Temporal } from '@js-temporal/polyfill';
import { fsLog, importJSON, PATH_CONFIG, PATH_CRASHLOG, PATH_MISCLOG, PATH_PS_FACTORYSETS, PATH_PS_INDEX, Services, shell } from './globals.js';

process.chdir(import.meta.dirname);
process.on('uncaughtExceptionMonitor', (e, origin) => {
	const time = Temporal.Now.zonedDateTimeISO().toLocaleString();
	const crashlog = `${time} ${origin}\n${e.stack}\n\n`;
	fsLog(PATH_CRASHLOG, crashlog);
});
process.on('exit', (code) => {
	fsLog(PATH_MISCLOG, `Process exiting with code ${code} ...\n`);
});

log('Welcome to 35Pokes Pokemon Showdown Bot Controller!');
log(`Project path: ${import.meta.dirname}`);
// Dependencies
try {
	const git = await shell('git -v');
	log(`Git found: ${git.slice(0, -1)}`);
}
catch(e) {
	log(`Git not found. This project depends on remote repositories; please install git.`);
	process.exit(1);
}
log('To exit gracefully, enter exit.');

const services: Services = {};
const servicesStopped: { [k in keyof Services]: number } = {};

const { app, port } = await (async () => {
	const { enable, port: portNum, portEnv } = importJSON(PATH_CONFIG).server;
	const app = enable ? (await import('express')).default() : null;
	const port: number = portNum >= 0 ? portNum : portEnv ? process.env[portEnv] : 0;
	return { app, port };
})();
let server: any;

const rl = readline.createInterface(process.stdin, process.stdout);

loadAll().then(() => rl.on('line', consoleInput));

function log(msg: string) {
	if(msg.includes('\n')) msg = `=== === ===\n${msg}\n=== === ===`;
	else msg = `=== ${msg} ===`;
	console.log(msg);
	fsLog(PATH_MISCLOG, `${msg}\n`);
}

async function loadAll() {
	await Promise.all([
		loadBattleFactory()
	]);
	if(app && !server && importJSON(PATH_CONFIG).server.enable) {
		server = app.listen(port, () => {
			log(`Express listening on port ${port}.`);
		});
	}
}

async function loadBattleFactory() {
	const { enable, maxRestarts, skipBuild } = importJSON(PATH_CONFIG).battleFactory;
	if(!enable) {
		log('Battle Factory is not enabled.');
		return;
	}

	const BattleFactory = (await import('./BattleFactory.js')).default;

	const missingDependencies = await BattleFactory.checkDependencies(skipBuild);
	if(missingDependencies.length) throw new Error(`Battle Factory missing dependencies: ${missingDependencies.join(', ')}`);

	// On first run, Express stack needs to be configured;
	// on non-first runs, the previous instance needs to be shut down.
	// Otherwise these are unrelated actions; don't get confused.
	if(services.BattleFactory) {
		delete services.BattleFactory.onShutdown;
		services.BattleFactory.shutdown();
	}
	else if(app){
		// @ts-expect-error Some typing nonsense
		app.use('/bf', await BattleFactory.serve(services));
	}

	services.BattleFactory = new BattleFactory();
	servicesStopped.BattleFactory ??= 0;
	services.BattleFactory.onShutdown = () => {
		servicesStopped.BattleFactory!++;
		setTimeout(() => {
			servicesStopped.BattleFactory!--;
		}, 30 * 60 * 1000);
		if(servicesStopped.BattleFactory! > maxRestarts) {
			log('Battle Factory has stopped too often recently. To manually restart it enter restart bf.');
			return;
		}
		log('Battle Factory has stopped, restarting in 5 minutes.');
		setTimeout(() => loadBattleFactory(), 5 * 60 * 1000);
	};

	await services.BattleFactory.init();
	await services.BattleFactory.connect();
	log('Battle Factory has started.');
}

async function consoleInput(input: string) {
  const fields = input.toLowerCase().split(' ');
	switch(fields[0]) {
		case 'exit':
		case 'quit':
		case 'bye':
		case 'q': {
			// should shutdown everything first
			log('BYE BYE');
			process.exit(0);
		}
		case 'restart':
		case 'r': {
			switch(fields[1]) {
				case undefined:
				case '':
				case 'everything':
				case 'all': {
					log('Restarting everything.');
					loadAll();
					return;
				}
				case 'battlefactory':
				case 'factory':
				case 'bf': {
					log('Restarting Battle Factory.');
					loadBattleFactory();
					return;
				}
				default: {
					log(`No such service as ${fields[1]} - valid options: bf, all.`);
					return;
				}
			}
		}
		case 'dump': {
			log('DUMP');
			let buf = 'Controller Dump\n';
			buf += `services: ${Object.keys(services).join(', ')};\n`;
			buf += `servicesStopped: ${Object.entries(servicesStopped).map((x) => `${x[0]}: ${x[1]}`).join(', ')};\n`;
			let s: keyof Services;
			for(s in services) {
				buf += services[s]?.dump() ?? `Could not dump ${s}\n`;
			}
			log(buf);
			return;
		}
		case 'env': {
			log(JSON.stringify(process.env));
			return;
		}
		default: {
			log('Controller Commands (type and enter):');
			log('exit: Shutdown everything and exit. Alias: quit, bye, q');
			log('restart service?|all: Restart service or else everything. Alias: r');
			return;
		}
	}
}
