import * as nodemailer from 'nodemailer';

export interface SmtpConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
}

export const createTransporter = (config: SmtpConfig): nodemailer.Transporter =>
  nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.port === 465,

    auth: {
      user: config.user,
      pass: config.pass,
    },

    pool: true,
    maxConnections: 2,
    maxMessages: 50,

    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
