import path from 'path';

export interface Auth {
	name: string,
	pass: string
}

export interface Services {
	BattleFactory?: import('./BattleFactory').default
}

/**
 * Resolved with the matching message.
 * Rejected with the matching message or RejectReason.
 * 
 * true:resolve, null:ignore, false:reject
 */
export type Predicate = (msg: string) => boolean | null;

/** Curried Predicate */
export type PredicateVar = (val: string) => Predicate;

export type Problems = string[];

export enum LogSign {
	IN = '<<',
	OUT = '>>',
	INFO = '::',
	WARN = '!!',
	ERR = 'XX'
}

export enum RejectReason {
	TIMEOUT = 'Timed out.',
	DISCONNECT = 'Disconnected.'
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

export const PATH_CONFIG = path.join(import.meta.dirname, '..', 'config.json');

export const PATH_PS_INDEX = path.join(import.meta.dirname, '..', '..', 'pokemon-showdown', 'dist', 'sim', 'index.js');

export const PATH_PS_FACTORYSETS = path.join(
	import.meta.dirname, '..', '..', 'pokemon-showdown', 'dist', 'data', 'random-battles', 'gen9', 'factory-sets.json'
);
