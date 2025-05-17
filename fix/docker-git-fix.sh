#! /bin/bash

# Alternative start script for use with docker containers like Pterodactyl.
# See also: https://potyarkin.com/posts/2022/no-user-exists-for-uid/

# cwd: /home/container

git clone https://github.com/swordfishtr/35PokesIndex
git clone https://github.com/smogon/pokemon-showdown
node ./35PokesPSBot/dist/Controller.js
