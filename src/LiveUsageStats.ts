/**
 * Live Usage Stats service
 * 
 * Configuration details:
 * enable - whether Controller should run this service.
 * debug - whether to display informational logs.
 * format - format to collect usage stats for.
 * serve - expose API that responds with usage stats (requires express).
 * interval - in seconds, how often to check public battles.
 */

import { DatabaseSync, StatementSync } from 'node:sqlite';
import { styleText } from 'node:util';
import { Temporal } from '@js-temporal/polyfill';
import PSBot from './PSBot.js';
import {
	fsLog, importJSON, PATH_CONFIG, PATH_LUS, PATH_MISCLOG, Predicate, PredicateVar, Services, ServiceState, sqlargs, TimeoutRejection
} from './globals.js';

export default class LiveUsageStats {

	#state: ServiceState = ServiceState.NEW;
	get state() { return this.#state; }

	debug: boolean = false;

	format = 'gen9nationaldex35pokes';

	Dex?: typeof import('../../pokemon-showdown/dist/sim/index.js').Dex;
	toID?: typeof import('../../pokemon-showdown/dist/sim/index.js').toID;

	db?: DatabaseSync;

	bot?: PSBot;

	interval?: NodeJS.Timeout;

	onShutdown?: () => void;

	constructor() {
		this.init = this.init.bind(this);
		this.connect = this.connect.bind(this);
		this.shutdown = this.shutdown.bind(this);
		this.log = this.log.bind(this);
		this.queryBattles = this.queryBattles.bind(this);
		this.RESPONSE = this.RESPONSE.bind(this);
		this.INITBATTLE = this.INITBATTLE.bind(this);
	}
	
	async init() {
		if(this.#state !== ServiceState.NEW) throw new Error();

		this.db = new DatabaseSync(PATH_LUS);
		this.db.exec(this.sql.createTables);

		const { debug, format } = importJSON(PATH_CONFIG).liveUsageStats;
		this.debug = !!debug;
		if(format) this.format = format;

		const PS = (await import('../../pokemon-showdown/dist/sim/index.js')).default;
		this.Dex = PS.Dex;
		this.toID = PS.toID;

		this.#state = ServiceState.INIT;
	}

	async connect() {
		if(this.#state !== ServiceState.INIT) throw new Error();

		this.bot = new PSBot('Live Usage Stats Bot', this.debug);
		this.bot.onDisconnect = this.shutdown; // Too extreme a measure for this one

		try {
			await this.bot.connect();
			const { interval } = importJSON(PATH_CONFIG).liveUsageStats;
			this.#state = ServiceState.ON;
			this.interval = setInterval(this.queryBattles, (interval || 60) * 1000);
		}
		catch(e) {
			this.shutdown();
			throw e;
		}
	}

	shutdown() {
		if(this.#state === ServiceState.OFF) return;
		if(![ServiceState.INIT, ServiceState.ON].includes(this.#state)) throw new Error();

		this.db?.close();
		delete this.bot?.onDisconnect;
		this.bot?.disconnect();
		clearInterval(this.interval);
		if(this.onShutdown) this.onShutdown();

		this.#state = ServiceState.OFF;
	}

	log(msg: string) {
		if(!this.debug) return;
		const time = Temporal.Now.zonedDateTimeISO().toLocaleString();
		let buf = `${time} :: LUS :: ${msg}\n`;
		fsLog(PATH_MISCLOG, buf);
		buf = styleText(['bold'], buf);
		console.log(buf);
	}

	async queryBattles() {
		if(this.#state !== ServiceState.ON) throw new Error();

		this.log('Query battles ...');

		this.bot!.send(`|/cmd roomlist ${this.format},none,`);
		const roomsData = await this.bot!.await('roomlist response', 30, this.RESPONSE);
		const { rooms } = JSON.parse(roomsData.split('|').pop()!);

		// These will be run one after another, not in parallel.
		for(const room in rooms) {
			if(this.sql.checkBattle!.get(sqlargs(room))) continue;

			this.log(`New battle: ${room} ...`);

			try {
				this.bot!.send(`|/join ${room}`);
				const battleData = await this.bot!.await('battle join', 30, this.INITBATTLE(room));

				const mons = battleData
				.split('\n')
				.map((x) => x.split('|', 4))
				.filter((x) => x[1] === 'poke') // If team preview is disabled, the array will be 0 length.
				.map((x) => x[3])
				.map((x) => x.split(', ').shift()!) // Remove gender suffix.
				.map(this.toID!);

				this.bot!.send(`|/noreply /leave ${room}`);

				if(!mons.length) {
					this.log(`Team preview disabled in ${room} - skipping.`);
					continue;
				}

				this.log(`Pokemon brought: ${mons.join(', ')}.`);

				const timestamp = parseInt(/\n\|t:\|(\d+)\n/.exec(battleData)!.pop()!);

				const roomid = this.sql.insertBattle!.run(sqlargs(room, timestamp)).lastInsertRowid;

				for(const mon of mons) {
					this.sql.insertPokemon!.run(sqlargs(mon));
					this.sql.insertUsage!.run(sqlargs(roomid, mon));
				}
			}
			catch(e) {
				if(!(e instanceof TimeoutRejection)) throw e;
				this.log(`Could not join ${room} - skipping.`);
			}
		}
	}

	readonly RESPONSE: Predicate = (msg) => {
		const data = msg.split('|', 4);
		return data[0] === '' &&
		data[1] === 'queryresponse' &&
		data[2] === 'roomlist' ||
		null;
	};

	readonly INITBATTLE: PredicateVar = (room) => (msg) => {
		const data = msg.split('\n', 2).map((x) => x.split('|', 3));
		return data[0]?.[0].slice(1) === room &&
		data[1]?.[0] === '' &&
		data[1][1] === 'init' &&
		data[1][2] === 'battle' ||
		null;
	};

	readonly sql = (() => {
		// Reference to parent class for use in the getters.
		const lus = this;
		return {

			createTables: `
CREATE TABLE IF NOT EXISTS pokemon (
	id INTEGER PRIMARY KEY,
	species TEXT UNIQUE NOT NULL
);
CREATE TABLE IF NOT EXISTS battles (
	id INTEGER PRIMARY KEY,
	room TEXT UNIQUE NOT NULL,
	timestamp INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS pokemon_in_battles (
	id INTEGER PRIMARY KEY,
	species_id INTEGER NOT NULL,
	room_id INTEGER NOT NULL,
	FOREIGN KEY (species_id) REFERENCES pokemon (id),
	FOREIGN KEY (room_id) REFERENCES battles (id)
);
`,
			get checkBattle() { return lus.db?.prepare(`
SELECT 1
FROM battles
WHERE room=?1;
`)},
			get insertBattle() { return lus.db?.prepare(`
INSERT INTO battles (room, timestamp)
VALUES (?1, ?2);
`); },
			get insertPokemon() { return lus.db?.prepare(`
INSERT INTO pokemon (species)
SELECT ?1
WHERE NOT EXISTS (
	SELECT 1
	FROM pokemon
	WHERE species=?1
);
`); },
			get insertUsage() { return lus.db?.prepare(`
INSERT INTO pokemon_in_battles (room_id, species_id)
SELECT ?1, id
FROM pokemon
WHERE species=?2;
`); },

		} as const satisfies Record<string, string | StatementSync | undefined>;
	})();

	static async serve(services: Services): Promise<Express.Application> {
		const app = (await import('express')).default();
		app.get('/', (req, res) => {
			res.send('Live Usage Stats go here');
		});
		return app;
	}

}

/*

>> |/cmd roomlist gen9nationaldex35pokes,none,
<< |queryresponse|roomlist|{"rooms":{}}

<< |queryresponse|roomlist|{"rooms":{"battle-gen9nationaldexuu-2349962948":{"p1":"AshPlaysMonss","p2":"2dasdsd","minElo":1000},"battle-gen9nationaldexuu-2349962535":{"p1":"Fowa2003","p2":"Kairak","minElo":1212},"battle-gen9nationaldexuu-2349962066":{"p1":"Kairak","p2":"Knurzerr","minElo":1277},"battle-gen9nationaldexuu-2349961197":{"p1":"sbwavez","p2":"Skalz15","minElo":1057},"battle-gen9nationaldexuu-2349956651":{"p1":"rmxq_bxllz","p2":"Override 12345"}}}

*/

/*

>> |/join battle-gen9uu-2367500348
<< >battle-gen9uu-2367500348
|init|battle
|title|orochilightspam vs. SlawBunnies
|html|<div class="broadcast-blue"><strong>[Gen 9] UU is currently suspecting Meowscarada! For information on how to participate check out the <a href="https://www.smogon.com/tools/suspects/view/108">suspect thread</a>.</strong></div>
|j|☆orochilightspam
|j|☆SlawBunnies
|t:|1747684765
|gametype|singles
|player|p1|orochilightspam|101|1237
|player|p2|SlawBunnies|170|1481
|teamsize|p1|6
|teamsize|p2|6
|gen|9
|tier|[Gen 9] UU
|rated|
|rule|HP Percentage Mod: HP is shown in percentages
|rule|Endless Battle Clause: Forcing endless battles is banned
|rule|Species Clause: Limit one of each Pokémon
|rule|OHKO Clause: OHKO moves are banned
|rule|Evasion Items Clause: Evasion items are banned
|rule|Evasion Moves Clause: Evasion moves are banned
|rule|Sleep Moves Clause: Sleep-inducing moves are banned
|clearpoke
|poke|p1|Keldeo|
|poke|p1|Hydrapple, M|
|poke|p1|Heatran, F|
|poke|p1|Tornadus-Therian, M|
|poke|p1|Lokix, M|
|poke|p1|Meowscarada, M|
|poke|p2|Lycanroc-Dusk, F|
|poke|p2|Scizor, M|
|poke|p2|Ogerpon-Cornerstone, F|
|poke|p2|Slowbro, F|
|poke|p2|Tyranitar, F|
|poke|p2|Mandibuzz, F|
|teampreview
|
|t:|1747684796
|start
|switch|p1a: Heatran|Heatran, F|100/100
|switch|p2a: Scizor|Scizor, M|100/100
|turn|1
|inactive|Battle timer is ON: inactive players will automatically lose when time's up. (requested by SlawBunnies)

<< >battle-gen9uu-2367500348
|
|t:|1747685218
|move|p2a: Scizor|Bullet Punch|p1a: Keldeo
|-resisted|p1a: Keldeo
|-damage|p1a: Keldeo|31/100
|move|p1a: Keldeo|Sacred Sword|p2a: Scizor
|-supereffective|p2a: Scizor
|-damage|p2a: Scizor|4/100 brn
|
|-damage|p2a: Scizor|0 fnt|[from] brn
|faint|p2a: Scizor
|
|win|orochilightspam

*/