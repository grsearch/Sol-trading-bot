/**
 * 日志模块
 */
import * as winston from 'winston';
import * as path from 'path';
import { config } from './config';

const logFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
  winston.format.errors({ stack: true }),
  winston.format.splat(),
  winston.format.printf((info) => {
    const { timestamp, level, message, module, ...meta } = info;
    const moduleStr = module ? `[${module}]` : '';
    const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
    return `${timestamp} ${level.toUpperCase().padEnd(5)} ${moduleStr} ${message}${metaStr}`;
  })
);

const logger = winston.createLogger({
  level: config.logLevel,
  format: logFormat,
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(winston.format.colorize(), logFormat),
    }),
    new winston.transports.File({
      filename: path.join('logs', 'error.log'),
      level: 'error',
      maxsize: 10 * 1024 * 1024,
      maxFiles: 5,
    }),
    new winston.transports.File({
      filename: path.join('logs', 'combined.log'),
      maxsize: 10 * 1024 * 1024,
      maxFiles: 10,
    }),
    new winston.transports.File({
      filename: path.join('logs', 'trades.log'),
      level: 'info',
      maxsize: 10 * 1024 * 1024,
      maxFiles: 30,
    }),
  ],
});

export function getLogger(moduleName: string) {
  return {
    debug: (msg: string, meta: object = {}) => logger.debug(msg, { module: moduleName, ...meta }),
    info: (msg: string, meta: object = {}) => logger.info(msg, { module: moduleName, ...meta }),
    warn: (msg: string, meta: object = {}) => logger.warn(msg, { module: moduleName, ...meta }),
    error: (msg: string, meta: object = {}) => logger.error(msg, { module: moduleName, ...meta }),
  };
}

export default logger;
