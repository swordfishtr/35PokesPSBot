/**
 * Entry point - Import from here for external use of this project's components.
 * 
 * 35Pokes is a NationalDex community in Smogon.
 * https://www.smogon.com/forums/threads/3749375
 */

// WebSocket client
export { default as PSBot } from './PSBot.js';

// 35Pokes specific services
export { default as BattleFactory } from './BattleFactory.js';
export { default as liveUsageStats } from './LiveUsageStats.js';

// Helper functions for managing dependencies
export * as DependencyScripts from './DependencyScripts.js';
