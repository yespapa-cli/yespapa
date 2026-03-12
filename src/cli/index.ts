#!/usr/bin/env node

import { Command } from 'commander';
import { initCommand } from './init.js';
import { VERSION } from '../index.js';

const program = new Command();

program
  .name('yespapa')
  .description('TOTP-authenticated command gateway for LLM agents and autonomous systems')
  .version(VERSION);

program.addCommand(initCommand);

program.parse();
