import { connect } from 'tls';

import { once } from 'events';

import * as R from 'ramda';

import mem from 'memoizerific';

import {
    taskEither as TE,
    function as F,
} from 'fp-ts';

import { logLevel } from '../model';
import type { Trojan } from '../config';

import {
    Fn,
    hash,
    timeout,
    catchKToError,
    socks5Handshake,
} from '../utils';

import type { ChainOpts } from './index';





export function chain (opts: ChainOpts, remote: Trojan) {

    const { ipOrHost, port, logger, hook } = opts;

    return F.pipe(

        TE.right(makeHead(remote.password, ipOrHost, port)),

        TE.apFirst(TE.fromIO(() => {

            if (R.not(logLevel.on.trace)) {
                return;
            }

            const merge = R.pick([ 'host', 'port', 'protocol' ]);

            logger
                .child({ proxy: merge(remote) })
                .trace('proxy through trojan')
            ;

        })),

        TE.chain(catchKToError(tunnel(remote))),

        TE.chain(catchKToError(hook)),

        TE.mapLeft(R.tap(() => hook())),

    );

}





const TIMEOUT = 1000 * 5;

export const tunnel = (opts: Trojan) => async (head: Uint8Array) => {

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
            R.not(verify_hostname) && { checkServerIdentity: F.constUndefined }
        ),

    });

    socket.setNoDelay(true);
    socket.setTimeout(TIMEOUT);
    socket.setKeepAlive(true, 1000 * 60);

    try {

        await Promise.race([
            once(socket, 'secureConnect'),
            timeout(TIMEOUT),
        ]);

        if (socket.write(head) !== true) {
            await once(socket, 'drain');
        }

    } catch (err) {
        socket.destroy();
        throw err;
    }

    return socket;

};





export const memHash = mem (256) (R.compose(
    Buffer.from,
    R.invoker(1, 'toString')('hex'),
    hash.sha224,
) as Fn<string, Buffer>);





export function makeHead (password: string, host: string, port: number) {

    return Uint8Array.from([

        ...memHash(password),

        0x0D, 0x0A,

        0x01, ...socks5Handshake(host, port).subarray(3),

        0x0D, 0x0A,

    ]);

}

