import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import axios from 'axios';
import pLimit from 'p-limit';
import type { Transporter } from 'nodemailer';
import * as dns from 'dns/promises';
import * as tls from 'tls';
import { ConfigService } from '@nestjs/config';
import { Site, sites } from 'src/variables/sites';
import { CheckResult } from 'src/@types/CheckResult';
import { WPCheckResult } from 'src/@types/WPCheckResult';
import { createTransporter } from 'src/utils/transporter';

@Injectable()
export class MonitorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MonitorService.name);
  private readonly concurrency = 5;
  private readonly limit = pLimit(this.concurrency);
  private sites: Site[] = sites;
  private transporter: Transporter;
  private readonly alertEmail: string;
  private readonly mailFrom: string;
  private readonly alertState = new Map<number, { notified: boolean }>();
  private readonly lastResults = new Map<
    number,
    CheckResult & { checkedAt: string }
  >();
  private readonly wpCache = new Map<
    number,
    { result: WPCheckResult; expiresAt: number }
  >();
  private readonly WP_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
  private isChecking = false;

  constructor(private readonly configService: ConfigService) {
    const host = this.requiredEnv('SMTP_HOST');
    const port = Number(this.requiredEnv('SMTP_PORT'));
    const user = this.requiredEnv('EMAIL_USER');
    const pass = this.requiredEnv('EMAIL_PASS');

    if (Number.isNaN(port)) {
      throw new Error('SMTP_PORT deve ser um número válido');
    }

    this.alertEmail = this.requiredEnv('ALERT_EMAIL');
    this.mailFrom = this.requiredEnv('MAIL_FROM');

    this.transporter = createTransporter({ host, port, user, pass });
  }

  private requiredEnv(key: string): string {
    const value = this.configService.get<string>(key);

    if (!value) {
      throw new Error(`Variável de ambiente obrigatória ausente: ${key}`);
    }

    return value;
  }

  async onModuleInit(): Promise<void> {
    for (const site of this.sites) {
      try {
        new URL(site.url);
      } catch {
        throw new Error(`URL inválida para o site ${site.name}: ${site.url}`);
      }
    }

    try {
      await this.transporter.verify();
      this.logger.log('Conexão SMTP verificada com sucesso');
    } catch (err) {
      this.logger.error(
        'Falha ao verificar conexão SMTP - emails podem não ser entregues',
        err,
      );
    }
  }

  onModuleDestroy(): void {
    this.transporter.close();
  }

  @Cron('*/1 * * * *') // cada 1 min
  async checkSites(): Promise<void> {
    if (this.isChecking) {
      this.logger.warn('Ciclo anterior ainda em execução - pulando ciclo');
      return;
    }

    this.isChecking = true;

    try {
      await Promise.all(
        this.sites.map((site) => this.limit(() => this.executeWithRetry(site))),
      );
    } finally {
      this.isChecking = false;
    }
  }

  getStatus(): Array<{
    site: Site;
    status: (CheckResult & { checkedAt: string }) | null;
  }> {
    return this.sites.map((site) => ({
      site,
      status: this.lastResults.get(site.id) ?? null,
    }));
  }

  private async executeWithRetry(site: Site): Promise<void> {
    try {
      let attempt = 0;

      while (attempt <= site.retries) {
        const startedAt = Date.now();
        const result = await this.checkSite(site);
        result.durationMs = Date.now() - startedAt;

        this.lastResults.set(site.id, {
          ...result,
          checkedAt: new Date().toISOString(),
        });

        if (result.isOnline) {
          await this.handleOnline(site);
          return;
        }

        attempt++;

        if (attempt > site.retries) {
          await this.handleOffline(site, result);
          return;
        }

        await this.sleep(this.getBackoff(attempt));
      }
    } catch (err) {
      this.logger.error(`Erro inesperado ao verificar ${site.name}`, err);
    }
  }

  private async handleOffline(site: Site, result: CheckResult): Promise<void> {
    const state = this.alertState.get(site.id) ?? { notified: false };

    if (state.notified) {
      this.logger.warn(`${site.name} segue OFFLINE (alerta já enviado)`);
      return;
    }

    state.notified = true;
    this.alertState.set(site.id, state);

    await this.notify(site, result);
  }

  private async handleOnline(site: Site): Promise<void> {
    const state = this.alertState.get(site.id);

    if (!state?.notified) return;

    this.alertState.set(site.id, { notified: false });

    await this.notifyRecovery(site);
  }

  private async checkSite(site: Site): Promise<CheckResult> {
    const url = new URL(site.url);

    const [dnsResolved, sslValid] = await Promise.all([
      this.checkDNS(url.hostname),
      url.protocol === 'https:'
        ? this.checkSSL(url.hostname)
        : Promise.resolve(true),
    ]);

    if (!dnsResolved)
      return {
        isOnline: false,
        dnsResolved,
        sslValid,
        error: 'DNS_FAIL',
      };

    try {
      const response = await axios.get(site.url, {
        timeout: site.timeout,
        validateStatus: () => true,
      });
      const isOnline = response.status >= 200 && response.status < 400;

      const wpCheck = await this.getWpCheck(site, isOnline);

      if (wpCheck?.isWordPress) {
        this.logger.log(
          `${site.name} - wp: true (${wpCheck.signals.join(',')}) - ${response.status} - ${isOnline ? 'Online' : 'Offline'}`,
        );
      } else {
        this.logger.log(
          `${site.name} - ${response.status} - ${isOnline ? 'Online' : 'Offline'}`,
        );
      }

      return {
        isOnline,
        statusCode: response.status,
        dnsResolved,
        sslValid,
      };
    } catch (err) {
      const code = axios.isAxiosError(err) ? err.code : undefined;
      const status = axios.isAxiosError(err) ? err.response?.status : undefined;

      this.logger.warn(
        `${site.name} - falha na checagem HTTP${code ? ` [${code}]` : ''}${status ? ` status=${status}` : ''}`,
      );

      return {
        isOnline: false,
        dnsResolved,
        sslValid,
        statusCode: status,
        error: code === 'ECONNABORTED' ? 'TIMEOUT' : 'HTTP_FAIL',
        errorCode: code,
      };
    }
  }

  private async checkDNS(host: string): Promise<boolean> {
    try {
      await this.withTimeout(dns.lookup(host), 3000);
      return true;
    } catch (err) {
      this.logger.warn(
        `DNS falhou para ${host}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  private async withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    let timer!: NodeJS.Timeout;

    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('TIMEOUT')), ms);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async getWpCheck(
    site: Site,
    isOnline: boolean,
  ): Promise<WPCheckResult | null> {
    if (!site.wpMonitor || !isOnline) return null;

    const cached = this.wpCache.get(site.id);

    if (cached && cached.expiresAt > Date.now()) return cached.result;

    const result = await this.checkWordPress(site);

    this.wpCache.set(site.id, {
      result,
      expiresAt: Date.now() + this.WP_CACHE_TTL_MS,
    });

    return result;
  }

  private async checkWordPress(site: Site): Promise<WPCheckResult> {
    const signals: string[] = [];
    const baseUrl = new URL(site.url).origin;

    try {
      const res = await axios.get(baseUrl, {
        timeout: site.timeout,
        validateStatus: () => true,
      });
      const html = typeof res.data === 'string' ? res.data : '';

      if (html.includes('wp-content')) signals.push('wp-content');
      if (html.includes('wp-includes')) signals.push('wp-includes');

      try {
        const wpJson = await axios.get(`${baseUrl}/wp-json`, {
          timeout: 3000,
          validateStatus: () => true,
        });

        if (wpJson.status === 200) {
          signals.push('wp-json');
        }
      } catch (err) {
        this.logger.debug(
          `Probe wp-json falhou para ${baseUrl}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      try {
        const login = await axios.get(`${baseUrl}/wp-login.php`, {
          timeout: 3000,
          validateStatus: () => true,
        });

        if ([200, 302].includes(login.status)) {
          signals.push('wp-login');
        }
      } catch (err) {
        this.logger.debug(
          `Probe wp-login falhou para ${baseUrl}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      const headers = res.headers;

      if (
        typeof headers['x-powered-by'] === 'string' &&
        headers['x-powered-by'].toLowerCase().includes('wordpress')
      ) {
        signals.push('headers');
      }
      return {
        isWordPress: signals.length >= 2,
        signals,
      };
    } catch (err) {
      this.logger.debug(
        `WP check falhou para ${site.name}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return {
        isWordPress: false,
        signals: [],
      };
    }
  }

  private async checkSSL(host: string): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;

      const finish = (valid: boolean) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve(valid);
      };

      const socket: tls.TLSSocket = tls.connect(
        {
          host,
          port: 443,
          servername: host,
          timeout: 3000,
        },
        () => {
          const cert = socket.getPeerCertificate();

          if (!cert || !cert.valid_to) return finish(false);

          finish(new Date(cert.valid_to) > new Date());
        },
      );

      socket.on('error', () => finish(false));
      socket.on('timeout', () => finish(false));
    });
  }

  private getBackoff(attempt: number): number {
    return Math.min(1000 * 2 ** attempt, 10000);
  }
  private sleep(ms: number): Promise<void> {
    return new Promise((res) => setTimeout(res, ms));
  }
  private async notify(site: Site, result: CheckResult): Promise<void> {
    this.logger.error(`${site.name} OFFLINE - sending notify...`);

    try {
      const info = (await this.transporter.sendMail({
        from: this.mailFrom,
        to: this.alertEmail,
        subject: `Site OFFLINE: ${site.name}`,
        text: `
        Site: ${site.url}
        DNS: ${result.dnsResolved}
        SSL: ${result.sslValid}
        Status: ${result.statusCode ?? 'N/A'}
        Error: ${result.error ?? 'N/A'}
        Code: ${result.errorCode ?? 'N/A'}
        Duração: ${result.durationMs ?? 'N/A'}ms
      `,
      })) as { messageId?: string };
      this.logger.log(`Email enviado | messageID=${info.messageId}`);
    } catch (err) {
      this.logger.error(
        `Falha ao enviar email de notificação: ${site.name}`,
        err,
      );
    }
  }

  private async notifyRecovery(site: Site): Promise<void> {
    this.logger.log(
      `${site.name} ONLINE novamente - sending recovery notify...`,
    );

    try {
      const info = (await this.transporter.sendMail({
        from: this.mailFrom,
        to: this.alertEmail,
        subject: `Site ONLINE novamente: ${site.name}`,
        text: `
        Site: ${site.url}
        O site voltou a responder normalmente.
      `,
      })) as { messageId?: string };
      this.logger.log(
        `Email de recuperação enviado | messageID=${info.messageId}`,
      );
    } catch (err) {
      this.logger.error(
        `Falha ao enviar email de recuperação: ${site.name}`,
        err,
      );
    }
  }
}
