/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument */
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import * as dns from 'dns/promises';
import * as tls from 'tls';
import { EventEmitter } from 'events';
import { MonitorService } from './monitor.service';
import { Site } from '../../variables/sites';

jest.mock('p-limit', () => ({
  __esModule: true,
  default: () => (fn: () => Promise<unknown>) => fn(),
}));

const env = {
  SMTP_HOST: 'smtp.test',
  SMTP_PORT: '587',
  EMAIL_USER: 'user@test',
  EMAIL_PASS: 'pass',
  ALERT_EMAIL: 'alert@test',
  MAIL_FROM: '"Monitor" <monitor@test>',
};

const configStub = {
  get: (key: string) => env[key as keyof typeof env],
} as unknown as ConfigService;

const testSite: Site = {
  id: 99,
  name: 'Teste',
  url: 'https://teste.local/api/hello',
  timeout: 1000,
  retries: 2,
};

const makeAxiosResponse = (status: number) => ({
  status,
  headers: {} as Record<string, unknown>,
  data: '',
});

describe('MonitorService', () => {
  let service: MonitorService;
  let axiosGet: jest.SpyInstance;
  let dnsLookup: jest.SpyInstance;
  let sendMailMock: jest.Mock;
  let certValidTo: string;

  beforeEach(() => {
    certValidTo = 'Aug 01 2099 12:00:00 GMT';
    service = new MonitorService(configStub);
    (service as any).sites = [testSite];
    jest.spyOn(service as any, 'sleep').mockResolvedValue(undefined);

    sendMailMock = jest.fn().mockResolvedValue({ messageId: 'test-id' });
    (service as any).transporter = {
      sendMail: sendMailMock,
      verify: jest.fn(),
      close: jest.fn(),
    };

    axiosGet = jest
      .spyOn(axios, 'get')
      .mockResolvedValue(makeAxiosResponse(200));

    dnsLookup = jest.spyOn(dns, 'lookup').mockResolvedValue({
      address: '127.0.0.1',
      family: 4,
    });

    jest.spyOn(tls, 'connect').mockImplementation(((
      _opts: unknown,
      cb?: (err: Error | null) => void,
    ) => {
      const socket: any = new EventEmitter();
      socket.destroy = jest.fn();
      socket.getPeerCertificate = jest.fn(() => ({ valid_to: certValidTo }));
      process.nextTick(() => cb?.(null));
      return socket as tls.TLSSocket;
    }) as any);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('site online não envia alerta e registra snapshot com duração', async () => {
    await service.checkSites();

    expect(sendMailMock).not.toHaveBeenCalled();

    const [entry] = service.getStatus();
    expect(entry.status?.isOnline).toBe(true);
    expect(entry.status?.statusCode).toBe(200);
    expect(entry.status?.durationMs).toBeGreaterThanOrEqual(0);
    expect(entry.status?.checkedAt).toBeTruthy();
  });

  it('queda persistente envia 1 alerta, deduplica e notifica recuperação', async () => {
    axiosGet.mockResolvedValue(makeAxiosResponse(500));

    await service.checkSites();
    expect(sendMailMock).toHaveBeenCalledTimes(1);

    const alertArgs = sendMailMock.mock.calls[0][0] as {
      subject: string;
      text: string;
    };
    expect(alertArgs.subject).toContain('OFFLINE');
    expect(alertArgs.text).toContain('500');

    await service.checkSites();
    expect(sendMailMock).toHaveBeenCalledTimes(1);

    axiosGet.mockResolvedValue(makeAxiosResponse(200));
    await service.checkSites();
    expect(sendMailMock).toHaveBeenCalledTimes(2);
    expect(
      (sendMailMock.mock.calls[1][0] as { subject: string }).subject,
    ).toContain('ONLINE novamente');

    axiosGet.mockResolvedValue(makeAxiosResponse(500));
    await service.checkSites();
    expect(sendMailMock).toHaveBeenCalledTimes(3);
  });

  it('falha de DNS retorna DNS_FAIL e alerta', async () => {
    dnsLookup.mockRejectedValue(new Error('lookup EAI_AGAIN'));

    await service.checkSites();

    expect(axiosGet).not.toHaveBeenCalled();
    expect(sendMailMock).toHaveBeenCalledTimes(1);

    const entry = service.getStatus()[0];
    expect(entry.status?.error).toBe('DNS_FAIL');
    expect(entry.status?.isOnline).toBe(false);

    expect((sendMailMock.mock.calls[0][0] as { text: string }).text).toContain(
      'DNS_FAIL',
    );
  });

  it('timeout HTTP é reportado como TIMEOUT com errorCode', async () => {
    const timeoutError = Object.assign(new Error('timeout exceeded'), {
      code: 'ECONNABORTED',
      isAxiosError: true,
      config: {},
    });
    axiosGet.mockRejectedValue(timeoutError);

    await service.checkSites();

    expect(sendMailMock).toHaveBeenCalledTimes(1);

    const entry = service.getStatus()[0];
    expect(entry.status?.error).toBe('TIMEOUT');
    expect(entry.status?.errorCode).toBe('ECONNABORTED');

    expect((sendMailMock.mock.calls[0][0] as { text: string }).text).toContain(
      'TIMEOUT',
    );
  });

  it('guard de overlap impede ciclo concorrente', async () => {
    (service as any).isChecking = true;

    await service.checkSites();

    expect(axiosGet).not.toHaveBeenCalled();
  });

  it('SSL expirado marca resultado como sslValid false', async () => {
    certValidTo = 'Aug 01 1999 12:00:00 GMT';

    await service.checkSites();

    expect(service.getStatus()[0].status?.sslValid).toBe(false);
    expect(sendMailMock).not.toHaveBeenCalled();
  });
});
