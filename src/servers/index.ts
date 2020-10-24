import net from 'net';

import type { Logger } from 'pino';

import * as R from 'ramda';

import {
    task as T,
    taskEither as TE,
    map as fpMap,
    eq as Eq,
    option as O,
    function as F,
    readonlyArray as A,
} from 'fp-ts';

import type { Remote } from '../config';
import { DoH, Fn, run, tryCatchToError, mem } from '../utils';
import { logLevel } from '../model';
import type { Hook } from '../services/index';

import { chain as chainHttp } from './http';
import { chain as chainSocks5 } from './socks5';
import { chain as chainTrojan } from './trojan';
import { chain as chainShadowSocks } from './shadowsocks';





type Opts = {
    host: string;
    port: number;
    hook: Hook;
    dns: O.Option<ReturnType<typeof DoH>>;
    doh: Fn<string, boolean>;
    logger: Logger;
};

export type ChainOpts = Pick<Opts, 'port' | 'logger' | 'hook'> & {
    ipOrHost: string;
};





const dnsCache = new Map<string, string>();
const nsLookup = (host: string) => fpMap.lookup (Eq.eqString) (host) (dnsCache);

const hostCache = mem.in256(O.some);





/*#__NOINLINE__*/
export function connect ({ host, port, hook, dns, doh, logger }: Opts) {

    const justHost = hostCache(host);
    const check = doh(host) ? F.constUndefined : F.constant(host);

    /*#__NOINLINE__*/
    return async function toServer (server: O.Option<Remote> | 'nothing') {

        // hot path optimization
        // switch to native nullish-coalescing when targeting to node >= 14

        // eslint-disable-next-line max-len, @typescript-eslint/prefer-nullish-coalescing, @typescript-eslint/strict-boolean-expressions
        const ipOrHost = /*#__NOINLINE__*/ check() || await run(/*#__NOINLINE__*/ query()) || host;

        if (server === 'nothing') {

            return F.pipe(
                tryCatchToError(() => {
                    return hook(netConnectTo({ port, host: ipOrHost }));
                }),
                TE.mapLeft(R.tap(() => hook())),
            );

        }

        return F.pipe(

            server,

            TE.fromOption(() => new Error('Has no server to connect')),

            TE.chain(remote => {

                const opts = { port, logger, hook, ipOrHost };

                if (remote.protocol === 'socks5') {
                    return chainSocks5(opts, remote);
                }

                if (remote.protocol === 'trojan') {
                    return chainTrojan(opts, remote);
                }

                if (remote.protocol === 'ss') {
                    return chainShadowSocks(opts, remote);
                }

                if (remote.protocol === 'http'
                ||  remote.protocol === 'https' as string) {
                    return chainHttp(opts, remote);
                }

                return TE.left(
                    new Error(`Non supported protocol [${ remote.protocol }]`),
                );

            }),

            TE.mapLeft(R.tap(() => hook())),

        );

    };



    function query () {

        return F.pipe(

            O.chain (nsLookup) (justHost),
            TE.fromOption(() => new Error('No cache')),
            TE.alt(() => F.pipe(

                O.ap (justHost) (dns),
                TE.fromOption(() => new Error('No DoH')),
                TE.chain(/*#__NOINLINE__*/ parse),

            )),

            TE.getOrElseW(() => T.fromIO(F.constUndefined)),

        );
    }



    function parse (results: ReturnType<ReturnType<typeof DoH>>) {

        return F.pipe(

            results,

            TE.map(F.flow(

                A.findFirst(R.where({
                    type: R.equals(1),
                    data: R.is(String),
                })),

                O.map(R.tap(({ data: ip, TTL }) => {

                    if (O.isNone(nsLookup(host))) {
                        dnsCache.set(host, ip);
                        setTimeout(() => dnsCache.delete(host), TTL * 1000);
                    }

                    if (R.not(logLevel.on.trace)) {
                        return;
                    }

                    logger.child({ ip }).trace('DoH');

                })),

                O.map(R.prop('data')),

            )),

            TE.chain(TE.fromOption(() => new Error('No valid entries'))),

        );

    }

}





export const netConnectTo: Fn<net.TcpNetConnectOpts, net.Socket> = R.compose(

    R.tap(socket => socket
        .setNoDelay(true)
        .setTimeout(1000 * 5)
        .setKeepAlive(true, 1000 * 60),
    ),

    net.connect as Fn<net.NetConnectOpts, net.Socket>,

    R.mergeRight({
        allowHalfOpen: true,
    }),

);

