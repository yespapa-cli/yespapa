#!/usr/bin/env node

import { Command } from 'commander';
import { initCommand } from './init.js';
import { statusCommand } from './status.js';
import { rulesCommand } from './rules.js';
import { uninstallCommand } from './uninstall.js';
import { graceCommand } from './grace.js';
import { execCommand, approveCommand } from './exec.js';
import { rotateCommand } from './rotate.js';
import { startCommand, restartCommand } from './start.js';
import { configCommand } from './config.js';
import { testCommand } from './test.js';
import { VERSION } from '../index.js';

const program = new Command();

program
  .name('yespapa')
  .description('TOTP-authenticated command gateway for LLM agents and autonomous systems')
  .version(VERSION);

program.addCommand(initCommand);
program.addCommand(startCommand);
program.addCommand(restartCommand);
program.addCommand(statusCommand);
program.addCommand(rulesCommand);
program.addCommand(graceCommand);
program.addCommand(execCommand);
program.addCommand(approveCommand);
program.addCommand(rotateCommand);
program.addCommand(configCommand);
program.addCommand(testCommand);
program.addCommand(uninstallCommand);

program.parse();
