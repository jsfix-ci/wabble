import { type Socket } from 'net';
import { connect } from 'tls';

import * as R from 'ramda';

import {
    taskEither as TE,
    function as F,
} from 'fp-ts';

import type { Trojan } from '../config.js';

import * as u from '../utils/index.js';

import { RTE_O_E_V, destroyBy, elapsed } from './index.js';





export const chain: u.Fn<Trojan, RTE_O_E_V> = remote => opts => {

    const { host, port, hook, abort } = opts;

    return F.pipe(

        TE.rightIO(() => makeHead(remote.password, host, port)),

        TE.chain(tunnel(remote)),

        elapsed(remote, opts),

        TE.mapLeft(R.tap(abort)),

        TE.chain(hook),

    );

};





const timeoutError = new u.ErrorWithCode(
    'SERVER_SOCKET_TIMEOUT',
    'trojan server timeout',
);

const race = u.raceTaskByTimeout(1000 * 5, timeoutError);

export const tunnel = (opts: Trojan) => (head: Uint8Array) => u.bracket(

    TE.rightIO(() => {

        const { host, port, ssl } = opts;

        /* eslint-disable indent */
        const {
                    ciphers,
            sni:    servername = host,
            alpn:   ALPNProtocols,
            verify: rejectUnauthorized,
                    verify_hostname,
        } = ssl;
        /* eslint-enable indent */

        const socket = connect({

            host,
            port,

            ciphers,
            servername,
            ALPNProtocols,
            rejectUnauthorized,

            ...(
                R.not(verify_hostname)
                && { checkServerIdentity: F.constUndefined }
            ),

        });

        socket.setNoDelay(true);
        socket.write(head);

        return socket;

    }),

    (socket: Socket) => F.pipe(
        race(u.onceTE('secureConnect', socket)),
        TE.map(F.constant(socket)),
    ),

    destroyBy(timeoutError),

);





export const memHash = F.flow(
    u.hash.sha224,
    buf => buf.toString('hex'),
    Buffer.from as u.Fn<string, Uint8Array>,
);





export const makeHead = u.mem.in10((
        password: string,
        host: string,
        port: number,
): Uint8Array => Buffer.concat([

    memHash(password),

    Uint8Array.from([ 0x0D, 0x0A, 0x01 ]),

    u.socks5Handshake(host, port).subarray(3),

    Uint8Array.from([ 0x0D, 0x0A ]),

]));

