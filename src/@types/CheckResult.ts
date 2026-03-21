export interface CheckResult {
    isOnline: boolean,
    statusCode?: number,
    dnsResolved: boolean,
    sslValid: boolean,
    error?: string
}