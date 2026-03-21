import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import axios from 'axios';
import pLimit from 'p-limit';
import * as nodemailer from 'nodemailer'
import * as dns from 'dns/promises'
import * as https from 'https'
import * as tls from 'tls';
import { ConfigService } from '@nestjs/config';
import { Site, sites } from 'src/variables/sites';
import { CheckResult } from 'src/@types/CheckResult';
import { WPCheckResult } from 'src/@types/WPCheckResult';

@Injectable()
export class MonitorService {

    private readonly logger = new Logger(MonitorService.name)
    private readonly concurrency = 5
    private readonly limit = pLimit(this.concurrency)
    private sites: Site[] = sites
    private transporter: nodemailer.Transporter


    constructor(private readonly configService: ConfigService) {

        this.transporter = nodemailer.createTransport({
            host: process.env.SMTP_HOST,
            port: Number(process.env.SMTP_PORT),
            secure: Number(process.env.SMTP_PORT) === 465,

            auth: {
                user: process.env.EMAIL_USER,
                pass: process.env.EMAIL_PASS
            },

            pool: true,
            maxConnections: 2,
            maxMessages: 50,

            connectionTimeout: 10_000,
            greetingTimeout: 10_000,
            socketTimeout: 20_000
        })
    }

    @Cron('*/1 * * * *') // cada 1 min
    async checkSites(): Promise<void> {
        await Promise.all(
            this.sites.map(site => {
                this.limit(() => this.executeWithRetry(site))
                //if (site.id === 1) this.testNotify()
            }
            )
        )
    }

    private async executeWithRetry(site: Site): Promise<void> {
        let attempt = 0

        while (attempt <= site.retries) {
            const result = await this.checkSite(site)
            if (result.isOnline) return
            attempt++
            if (attempt > site.retries) {
                await this.notify(site, result)
                return
            }
            const delay = this.getBackoff(attempt)
            await this.sleep(2000)
        }
    }

    private async checkSite(site: Site): Promise<CheckResult> {
        const url = new URL(site.url)

        const dnsResolved = await this.checkDNS(url.hostname)
        const sslValid = url.protocol === 'https:' ? await this.checkSSL(url.hostname) : true

        if (!dnsResolved)
            return {
                isOnline: false, dnsResolved, sslValid, error: 'DNS_FAIL'
            }


        try {
            const response = await axios.get(site.url, {
                timeout: site.timeout,
                validateStatus: () => true,
            })
            const isOnline = response.status >= 200 && response.status < 400

            const wpCheck = await this.checkWordPress(site.url)

            if (wpCheck.isWordPress) {
                this.logger.log(`${site.name} - wp: ${wpCheck.isWordPress} (${wpCheck.signals.join(',')}) - ${response.status} - ${isOnline ? 'Online' : 'Offline'}`)
            } else {
                this.logger.log(`${site.name} - ${response.status} - ${isOnline ? 'Online' : 'Offline'}`)
            }

            return {
                isOnline,
                statusCode: response.status,
                dnsResolved,
                sslValid
            }

        } catch (err) {
            return {
                isOnline: false,
                dnsResolved,
                sslValid,
                error: 'HTTP_FAIL'
            }
        }
    }




    private async checkDNS(host: string): Promise<boolean> {
        try {
            await dns.lookup(host)/*.then(
                (result) =>
                    console.log('- Verificação DNS - address: %s host: %s', result.address, host))
             */
            return true
        } catch (err) {
            return false
        }
    }

    private async checkSSL(host: string): Promise<boolean> {
        return new Promise(resolve => {
            const socket: tls.TLSSocket = tls.connect(
                {
                    host,
                    port: 443,
                    servername: host,
                    timeout: 3000
                },
                () => {
                    const cert = socket.getPeerCertificate()

                    if (!cert || !cert.valid_to) {
                        socket.destroy()
                        return resolve(false)
                    }
                    /*console.log(
                        '- SSL - host: %s serial: %s validade: %s',
                        host,
                        cert.serialNumber,
                        cert.valid_to
                    )*/

                    const validTo = new Date(cert.valid_to)
                    socket.destroy()

                    resolve(validTo > new Date())
                }
            )
            socket.on('error', () => resolve(false))

            socket.on('timeout', () => {
                socket.destroy()
                resolve(false)
            })
        })
    }

    private getBackoff(attempt: number): number {
        return Math.min(1000 * 2 ** attempt, 10000)
    }
    private sleep(ms: number): Promise<void> {
        return new Promise(res => setTimeout(res, ms))
    }
    private async notify(site: Site, result: CheckResult): Promise<void> {
        this.logger.error(`${site.name} OFFLINE - sending notify...`)

        try {
            const info = await this.transporter.sendMail({
                from: '"Monitor" <contato@ericssongomes.com>',
                to: this.configService.get<string>('ALERT_EMAIL'),
                subject: `Site OFFLINE: ${site.name}`,
                text: `
        Site: ${site.url}
        DNS: ${result.dnsResolved}
        SSL: ${result.sslValid}
        Status: ${result.statusCode ?? 'N/A'}
        Error: ${result.error}
      `,

            })
            this.logger.log(`Email enviado | messageID=${info.messageId}`)
        } catch (err) {
            this.logger.error(`Falha ao enviar email de notificação: ${site.name}`, err)
        }
    }

    private async checkWordPress(url: string): Promise<WPCheckResult> {
        const signals: string[] = []

        try {
            const res = await axios.get(url, {
                timeout: 5000,
                validateStatus: () => true
            })
            const html = res.data as string

            if (html.includes('wp-content')) signals.push('wp-content')
            if (html.includes('wp-includes')) signals.push('wp-includes')

            try {
                const wpJson = await axios.get(`${url}/wp-json`, {
                    timeout: 3000,
                    validateStatus: () => true
                })

                if (wpJson.status === 200) {
                    signals.push('wp-json')
                }
            } catch { }


            try {
                const login = await axios.get(`${url}/wp-login.php`, {
                    timeout: 3000,
                    validateStatus: () => true
                })

                if ([200, 302].includes(login.status)) {
                    signals.push('wp-login')
                }
            } catch { }
            const headers = res.headers

            if (headers['x-powered-by']?.toLowerCase().includes('wordpress')) {
                signals.push('headers')
            }
            return {
                isWordPress: signals.length >= 2,
                signals
            }

        } catch {
            return {
                isWordPress: false,
                signals: []
            }
        }
    }
}
