const winston = require('winston');

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }), // Log stack traces
    winston.format.splat(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(info => `${info.timestamp} ${info.level}: ${info.message}` + (info.stack ? `\n${info.stack}` : ''))
      )
    }),
    new winston.transports.File({ filename: 'trading_bot_error.log', level: 'error' }),
    new winston.transports.File({ filename: 'trading_bot_combined.log' })
  ]
});

module.exports = logger;
