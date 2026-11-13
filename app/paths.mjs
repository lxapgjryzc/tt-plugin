// Where the app keeps its data and which port it listens on (requirements R9.2, R9.3).
import { join } from 'node:path';
import { homedir } from 'node:os';

export const HOME = process.env.CHAMBER_HOME
  || join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'Chamber');
export const PORT = Number(process.env.CHAMBER_PORT) || 47815;
export const DB_FILE = join(HOME, 'chamber.sqlite');
export const LOG_FILE = join(HOME, 'app.log');
export const EXIT_ALREADY_RUNNING = 3;
// Written when the user quits on purpose; the periodic restart check honours it and the
// next start of the app removes it (R9.6).
export const QUIT_FILE = join(HOME, 'quit');
