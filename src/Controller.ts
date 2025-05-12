/**
 * Controller, the starting point, responsible for handling services, which use PSBot.
 * 
 * The "server" configuration is used here. Details:
 * enable - whether to serve data from services that opt in.
 * port - system port to listen on, 0 for portEnv.
 * portEnv - environment variable for the port.
 * password - if not "", serve only if the request provides password.
 */

import readline from 'readline';
import express from 'express';
import { Temporal } from '@js-temporal/polyfill';
import { fsLog, importJSON, PATH_CONFIG, PATH_CRASHLOG, PATH_MISCLOG, PATH_PS_FACTORYSETS, PATH_PS_INDEX, Services } from './globals.js';

process.chdir(import.meta.dirname);
process.on('uncaughtExceptionMonitor', (err, origin) => {
	const time = Temporal.Now.zonedDateTimeISO().toLocaleString();
	const crashlog = `${time} ${origin}\n${err.stack}\n\n`;
	fsLog(PATH_CRASHLOG, crashlog);
});

log('Welcome to 35Pokes Pokemon Showdown Bot Controller!');
log(`Project path: ${import.meta.dirname}`);
log(`Global PATH_CONFIG: ${PATH_CONFIG}`);
log(`Global PATH_CRASHLOG: ${PATH_CRASHLOG}`);
log(`Global PATH_MISCLOG: ${PATH_MISCLOG}`);
log(`Global PATH_PS_FACTORYSETS: ${PATH_PS_FACTORYSETS}`);
log(`Global PATH_PS_INDEX: ${PATH_PS_INDEX}`);
log('To exit gracefully, enter exit.');

const services: Services = {};
const servicesStopped: { [k in keyof Services]: number } = {};

const app = express();
const port: number = (() => {
	const conf = importJSON(PATH_CONFIG).server;
	if(conf.port) return conf.port;
	if(conf.portEnv) return process.env[conf.portEnv];
	return 3000;
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
	if(!server && importJSON(PATH_CONFIG).server.enable) {
		server = app.listen(port, () => {
			log(`Express listening on port ${port}.`);
		});
	}
}

async function loadBattleFactory() {
	const { enable, maxRestarts } = importJSON(PATH_CONFIG).battleFactory;
	if(!enable) {
		log('Battle Factory is not enabled.');
		return;
	}

	// Check dependencies here

	const BattleFactory = (await import('./BattleFactory.js')).default;

	// On first run, Express stack needs to be configured;
	// on non-first runs, the previous instance needs to be shut down.
	// Otherwise these are unrelated actions, don't get confused.
	if(services.BattleFactory) {
		delete services.BattleFactory.onShutdown;
		services.BattleFactory.shutdown();
	}
	else {
		// @ts-expect-error Some typing nonsense
		app.use('/bf', BattleFactory.serve(services));
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

	services.BattleFactory.init();
	await services.BattleFactory.connect();
	log('Battle Factory has started.');
}

function consoleInput(input: string) {
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
			let buf = '';
			let x: keyof Services;
			for(x in services) {
				buf += services[x]?.dump() ?? `Could not dump ${x}`;
			}
			log(buf);
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
