export interface Site {
    id: number,
    url: string,
    name: string
    timeout: number
    retries: number
}

export const sites: Site[] = [
    {
        id: 1,
        name: 'FlixNext',
        url: 'https://flixnext.com.br/api/awake',
        timeout: 5000,
        retries: 2
    },
    {
        id: 2,
        name: 'Solurh',
        url: 'https://solurh.pro/api/hello',
        timeout: 5000,
        retries: 2
    },
    {
        id: 3,
        name: 'Engemarco',
        url: 'https://engemarcosolucoes.com/api/hello',
        timeout: 5000,
        retries: 2
    },
    {
        id: 4,
        name: 'WSADV',
        url: 'https://wsadv.com.br',
        timeout: 5000,
        retries: 2
    },
    {
        id: 5,
        name: 'subscription',
        url: 'https://api.flixnext.com.br/manager',
        timeout: 5000,
        retries: 2
    },
    {
        id: 6,
        name: 'mensageria',
        url: 'https://api.flixnext.com.br/mensageria',
        timeout: 5000,
        retries: 2
    },
    {
        id: 7,
        name: 'content',
        url: 'https://api.flixnext.com.br/content',
        timeout: 5000,
        retries: 2
    },
    {
        id: 8,
        name: 'userManager',
        url: 'https://api.flixnext.com.br/backend/acordar',
        timeout: 5000,
        retries: 2
    },
]