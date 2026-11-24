export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

const ts = () => new Date().toISOString().slice(11, 19);

export const consoleLogger: Logger = {
  info: (m) => console.log(`${ts()}  ${m}`),
  warn: (m) => console.warn(`${ts()}  WARN  ${m}`),
  error: (m) => console.error(`${ts()}  ERROR ${m}`),
};

export const silentLogger: Logger = { info() {}, warn() {}, error() {} };
