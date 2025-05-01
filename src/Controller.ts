import fs from 'fs';
import readline from 'readline';
import { Temporal } from '@js-temporal/polyfill';
import { PATH_CONFIG, PATH_CRASH, PATH_PS_FACTORYSETS, PATH_PS_INDEX, Services } from './globals.js';

process.on('uncaughtExceptionMonitor', (err, origin) => {
	const time = Temporal.Now.zonedDateTimeISO().toLocaleString();
	const crashlog = `${time} ${origin}\n${err}\n\n`;
	fs.appendFileSync(PATH_CRASH, crashlog);
});

process.chdir(import.meta.dirname);
log('Welcome to 35Pokes Pokemon Showdown Bot Controller!');
log(`Project path: ${import.meta.dirname}`);
log(`Global PATH_CONFIG: ${PATH_CONFIG}`);
log(`Global PATH_CRASH: ${PATH_CRASH}`);
log(`Global PATH_PS_FACTORYSETS: ${PATH_PS_FACTORYSETS}`);
log(`Global PATH_PS_INDEX: ${PATH_PS_INDEX}`);
log('To exit gracefully, enter exit.');

const services: Services = {};

const rl = readline.createInterface(process.stdin, process.stdout);

rl.on('line', (input) => {
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
			log('To be implemented.');
			return;
		}
		case 'dump': {
			log('DUMP');
			for(const x in services) {
				console.log(services[x as keyof Services]?.dump() ?? `Could not dump ${x}`);
			}
			log('===');
			return;
		}
		default: {
			log('Controller Commands (type and enter):');
			log('exit: Shutdown everything and exit. Alias: quit, bye, q');
			log('restart service?: Restart service or else everything. Alias: r');
		}
	}
});

loadAll();

function log(msg: string) {
	console.log(`=== ${msg} ===`);
}

function loadAll() {
	return Promise.all([
		loadBattleFactory()
	]);
}

async function loadBattleFactory() {
	const { enable } = (await import('../config.json', { with: { type: "json" } })).default.battleFactory;
	if(!enable) {
		log('Battle Factory is not enabled.');
		return;
	}

	// Check dependencies here

	if(services.BattleFactory) {
		delete services.BattleFactory.onShutdown;
		services.BattleFactory.shutdown();
	}

	const BattleFactory = (await import('./BattleFactory.js')).default;
	services.BattleFactory = new BattleFactory();
	services.BattleFactory.onShutdown = () => {
		log('To restart Battle Factory, enter restart bf.');
	};
	await services.BattleFactory.init();
	await services.BattleFactory.connect();

	log('Battle Factory started.');
}
