// Entry point

process.chdir(__dirname);
console.log('=== Welcome to 35Pokes Showdown bots! ===\n');

try {
	require.resolve('../config.json');
}
catch(err: any) {
	if (err.code !== 'MODULE_NOT_FOUND') throw err;
	console.error('Config not found. Copy config-sample.json as config.json and populate it.');
	process.exit(1);
}

const { features } = require('../config.json');
console.log('Loaded config.');

const BattleFactory: typeof import('./BattleFactory.js').BattleFactory | null = (() => {
	if(!features.battlefactory) return null;
	try {
		require.resolve('../../pokemon-showdown/dist/sim/index.js');
	}
	catch(err: any) {
		if (err.code !== 'MODULE_NOT_FOUND') throw err;
		console.error('Dependency of 35 Factory missing:');
		console.error('Pokemon Showdown not found. Go to the parent directory of this project and run the following commands:');
		console.error('git clone https://github.com/smogon/pokemon-showdown');
		console.error('cd pokemon-showdown');
		console.error('node build decl');
		process.exit(1);
	}
	const { logins } = require('../config.json');
	if(logins.filter((x: any) => x.name && x.pass).length < 2) {
		console.error('Not enough logins provided in config or missing fields in logins.');
		process.exit(1);
	}
	return require('./BattleFactory.js').BattleFactory;
})();
if(BattleFactory) console.log('Loaded 35 Factory.');
let bf: import('./BattleFactory.js').BattleFactory;

// load other services

function loadFactory() {
	if(!BattleFactory) {
		console.error('35 Factory is not loaded.');
		return;
	}

	if(bf) {
		console.log('=== Shutting down previous instance of 35 Factory. ===');
		bf.shutdown();
	}

	console.log('=== Starting 35 Factory. ===')
	bf = new BattleFactory([0, 1], features.debug);

	bf.onShutdown = () => console.log('=== 35 Factory shut down. To restart it run loadFactory(); ===');
}

// todo
// manip showdown dist files here
// expose interfaces here based on config.features
// expose tools to refresh seamlessly (git pull, build, etc)
// node build decl

/*
silences unnecessary errors
.catch((err) => {
	// Likely error in code
	if(typeof err !== 'string') throw err;
	// No need to announce
	if(Object.values(RejectReason).includes(err as RejectReason)) throw 0;
	// Handle expected error
})
*/
