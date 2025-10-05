/**
 * Live Usage Stats service
 * 
 * Configuration details:
 * enable - whether Controller should run this service.
 * formats - formats to collect usage stats for.
 * rankedOnly - whether to ignore unranked (i.e. challenge) battles.
 * interval - in seconds, how often to check public battles.
 * maxRestartCount - max number of disconnections within maxRestartTimeframe.
 * If this is surpassed, the service won't restart automatically.
 * maxRestartTimeframe - Timeframe in minutes for maxRestartCount.
 * serve - expose API that responds with usage stats (requires express).
 */

import { DatabaseSync, StatementSync } from 'node:sqlite';
import { styleText } from 'node:util';
import { Temporal } from '@js-temporal/polyfill';
import PSBot from './PSBot.js';
import {
	fsLog, importJSON, index, PATH_35_INDEX, PATH_CONFIG, PATH_LUS, PATH_MISCLOG, PATH_PS_INDEX, Predicate,
	PredicateVar, Services, ServiceState, sqlargs, TimeoutRejection
} from './globals.js';

export default class LiveUsageStats {

	static dependencies: string[] = [PATH_35_INDEX, '../../pokemon-showdown'];

	#state = ServiceState.NEW;
	formats = ['gen9nationaldex35pokes'];
	rankedOnly = false;

	toID?: typeof import('../../pokemon-showdown/dist/sim/index.js').toID;
	Dex?: typeof import('../../pokemon-showdown/dist/sim/index.js').Dex;

	db?: DatabaseSync;
	bot?: PSBot;
	interval?: NodeJS.Timeout;

	onShutdown?: () => void;
	
	readonly init = async () => {
		if(this.#state !== ServiceState.NEW) throw new Error();

		this.db = new DatabaseSync(PATH_LUS);
		this.db.exec(this.sql.createTables);

		const { formats, rankedOnly } = importJSON(PATH_CONFIG).liveUsageStats;
		if(formats) this.formats = formats;
		this.rankedOnly = rankedOnly;

		const PS = (await import(PATH_PS_INDEX)).default;
		this.toID = PS.toID;
		this.Dex = PS.Dex;

		this.#state = ServiceState.INIT;
	};

	readonly connect = async () => {
		if(this.#state !== ServiceState.INIT) throw new Error();

		this.bot = new PSBot('Live Usage Stats Bot', this);
		this.bot.onDisconnect = this.shutdown;

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
	};

	readonly shutdown = () => {
		if(this.#state === ServiceState.OFF) return;
		if(![ServiceState.INIT, ServiceState.ON].includes(this.#state)) throw new Error();

		this.db?.close();
		delete this.bot?.onDisconnect;
		this.bot?.disconnect();
		clearInterval(this.interval);
		if(this.onShutdown) this.onShutdown();

		this.#state = ServiceState.OFF;
	};

	readonly log = (msg: string) => {
		const time = Temporal.Now.zonedDateTimeISO().toLocaleString();
		let buf = `${time} :: LUS :: ${msg}\n`;
		fsLog(PATH_MISCLOG, buf);
		buf = styleText(['bold'], buf);
		console.log(buf);
	};

	readonly dump = () => {
		let buf = 'Live Usage Stats Dump\n';
		buf += `state: ${this.#state}\n`;
		return buf;
	};

	readonly queryBattles = async () => {
		if(this.#state !== ServiceState.ON) throw new Error();

		this.log('Query battles ...');
		for(const format of this.formats) {

			this.bot!.send(`|/cmd roomlist ${format},none,`);
			const roomsData = await this.bot!.await('roomlist response', 30, this.RESPONSE);
			const { rooms } = JSON.parse(roomsData.split('|').pop()!);

			for(const room in rooms) {
				if(this.rankedOnly && !rooms[room].minElo) continue;
				if(this.sql.checkBattle!.get(sqlargs(room))) continue;

				this.log(`New battle: ${room} ...`);

				try {
					this.bot!.send(`|/join ${room}`);
					const battleData = await this.bot!.await('battle join', 30, this.INITBATTLE(room));
					this.bot!.send(`|/noreply /leave ${room}`);

					const mons = battleData
					.split('\n')
					.map((x) => x.split('|', 4))
					.filter((x) => x[1] === 'poke') // If team preview is disabled, the array will be 0 length.
					.map((x) => x[3])
					.map((x) => x.split(', ').shift()!) // Remove gender suffix.
					.map(this.processPokemon)
					.filter((x) => x);

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
	};

	// We need to:
	// - store cosmetic formes as base formes
	// - treat cosmetic formes in index as base formes
	// - treat teampreview-hidden species in index as base formes
	readonly processPokemon = (mon: string): ID => {
		const previewHidden = [
			'greninja', 'gourgeist', 'pumpkaboo', 'xerneas', 'silvally', 'urshifu', 'dudunsparce',
		]
		const species = this.Dex!.species.get(mon);
		if(!species.exists) return '';

		const baseSpecies = this.Dex!.species.get(species.baseSpecies);

		if(previewHidden.includes(baseSpecies.id)) {
			return baseSpecies.id;
		}

		// this will fail in certain cases like Vivillon
		if(baseSpecies.cosmeticFormes?.includes(species.name)) {
			return baseSpecies.id;
		}

		return species.id;
	};

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
			get getFullUsage() { return lus.db?.prepare(`
SELECT b.room, p.species
FROM pokemon p
JOIN pokemon_in_battles pb
ON (p.id=pb.species_id)
JOIN battles b
ON (pb.room_id=b.id);
`); },

		} as const satisfies Record<string, string | StatementSync | undefined>;
	})();

	static async serve(services: Services): Promise<Express.Application> {
		const app = (await import('express')).default();
		app.get('/', (req, res) => {
			if(!services.LiveUsageStats) {
				res.status(503).json({ error: 'Live Usage Stats is disabled.' });
				return;
			}
			res.send(`<a href="/lus/full">full</a><br />`);
		});
		app.get('/full', (req, res) => {
			if(!services.LiveUsageStats) {
				res.status(503).json({ error: 'Live Usage Stats is disabled.' });
				return;
			}
			const raw = services.LiveUsageStats.sql.getFullUsage!.all();
			const out: Record<string, string[]> = {};
			for(const { room, species } of raw) {
				out[room as any] ??= [];
				out[room as any].push(species as any);
			}
			res.json(out);
		});
		app.get('/:group/:meta', (req, res) => {
			if(!services.LiveUsageStats) {
				res.status(503).json({ error: 'Live Usage Stats is disabled.' });
				return;
			}
			let { group, meta } = req.params;
			if(!meta.endsWith('.txt')) meta += '.txt';
			const format = index.metagames[group]?.[meta]
			?.filter((x) => !x.header)
			.map((x) => services.LiveUsageStats!.processPokemon(x.value))
			.filter((x) => x);
			if(!format) {
				res.status(404).json({ error: 'Format not found.' });
				return;
			}
			const raw = services.LiveUsageStats.sql.getFullUsage!.all();
			const out: Record<string, string[]> = {};
			for(const { room, species } of raw) {
				out[room as any] ??= [];
				out[room as any].push(species as any);
			}
			for(const room in out) {
				if(!out[room].every((mon) => format.includes(mon as ID))) {
					delete out[room];
				}
			}
			res.json(out);
		});
		return app;
	}

}
