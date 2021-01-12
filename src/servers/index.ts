import net from 'net';

import type { Logger } from 'pino';

import * as R from 'ramda';

import {
    monoid,
    task as T,
    taskEither as TE,
    map as fpMap,
    eq as Eq,
    either as E,
    option as O,
    function as F,
    readonlyArray as A,
    readonlyNonEmptyArray as RNEA,
} from 'fp-ts';

import type { Remote } from '../config';
import * as u from '../utils';
import { logLevel, Resolver } from '../model';
import type { Hook } from '../services/index';

import { chain as chainHttp } from './http';
import { chain as chainSocks5 } from './socks5';
import { chain as chainTrojan } from './trojan';
import { chain as chainShadowSocks } from './shadowsocks';





type Opts = {
    host: string;
    port: number;
    hook: (...args: Parameters<Hook>) => TE.TaskEither<Error, void>;
    resolver: Resolver;
    logger: Logger;
};

export type ChainOpts = Pick<Opts, 'host' | 'port' | 'logger' | 'hook'>;





/*#__NOINLINE__*/
export function connect (opts: Opts) {

    /*#__NOINLINE__*/
    return function toServer (server: O.Option<Remote> | 'origin') {

        const { port, hook } = opts;

        if (server === 'origin') {
            return F.pipe(

                resolve(opts),
                TE.map(host => netConnectTo({ host, port })),
                TE.chain(hook),
                TE.mapLeft(R.tap(hook())),

            );
        }

        return F.pipe(

            server,

            TE.fromOption(() => new Error('Has no server to connect')),

            TE.apFirst(resolve(opts)),

            TE.chain(remote => {

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

            TE.mapLeft(R.tap(hook())),

        );

    };

}





const isIP = O.fromPredicate(u.isIP);



const checkBlockingHost = TE.filterOrElse(F.not(u.isBlockedIP), () => {
    return new ErrorWithCode('BLOCKED_HOST', 'Blocked via DoH or DNS');
});



const race = F.flow(
    A.compact,
    RNEA.flatten as never,
    RNEA.fromReadonlyArray as never,
    O.map(monoid.fold(T.getRaceMonoid<E.Either<Error, string>>())),
);





/*#__NOINLINE__*/
function resolve (opts: Opts) {

    const { host, resolver: { doh, dns } } = opts;

    return F.pipe(

        isIP(host),

        O.alt(() => /*#__NOINLINE__*/ nsLookup(host)),

        O.map(TE.right),

        O.alt(() => race([
            O.map (RNEA.map(/*#__NOINLINE__*/ fromDoH(opts))) (doh),
            O.map (RNEA.map(/*#__NOINLINE__*/ fromDNS(opts))) (dns),
        ])),

        TE.fromOption(() => Error('No cache nor DoH or DNS')),
        TE.flatten,
        TE.alt(() => TE.right(host)),

        checkBlockingHost,

    );

}





/*#__NOINLINE__*/
const fromDoH = (opts: Opts) => (query: u.DoH_query) => {

    const { host, logger } = opts;

    return F.pipe(

        query(host),

        TE.map(/*#__NOINLINE__*/ A.findFirst(R.where({
            type: R.equals(1),
            data: R.is(String),
        }))),

        TE.chain(TE.fromOption(() => Error('No valid entries'))),

        TE.chainFirst(({ data: ip, TTL }) => TE.fromIO(() => {

            updateCache (opts) (ip) (TTL);

            if (R.not(logLevel.on.trace)) {
                return;
            }

            logger.child({ ip }).trace('DoH');

        })),

        TE.map(R.prop('data')),

    );

};





/*#__NOINLINE__*/
const fromDNS = (opts: Opts) => (query: u.DNS_query) => {

    const { host, logger } = opts;

    return F.pipe(

        query(host),

        TE.map(/*#__NOINLINE__*/ A.findFirst(R.where({
            address: R.is(String),
        }))),

        TE.chain(TE.fromOption(() => Error('No valid entries'))),

        TE.chainFirst(({ address: ip, ttl: TTL }) => TE.fromIO(() => {

            updateCache (opts) (ip) (TTL);

            if (R.not(logLevel.on.trace)) {
                return;
            }

            logger.child({ ip }).trace('DNS');

        })),

        TE.map(R.prop('address')),

    );

};





const setCache: u.CurryT<[

    Map<string, string>,
    Opts,
    string,
    number,
    void,

]> = cache => opts => ip => seconds => {

    const { host, resolver: { ttl } } = opts;

    if (cache.has(host) === true) {
        return;
    }

    cache.set(host, ip);

    const timeout = F.pipe(
        ttl,
        O.map(({ calc }) => calc(seconds)),
        O.getOrElse(() => seconds),
    );

    setTimeout(() => cache.delete(host), timeout * 1000);

};

const dnsCache = new Map<string, string>();
const nsLookup = (host: string) => fpMap.lookup (Eq.eqString) (host) (dnsCache);
const updateCache = setCache(dnsCache);





export class ErrorWithCode extends Error {

    constructor (public code?: string, message?: string) {
        super(message);
    }

}





export const netConnectTo: u.Fn<net.TcpNetConnectOpts, net.Socket> = R.compose(

    R.tap(socket => socket
        .setNoDelay(true)
        .setTimeout(1000 * 5)
        .setKeepAlive(true, 1000 * 60),
    ),

    net.connect as u.Fn<net.NetConnectOpts, net.Socket>,

    R.mergeRight({
        allowHalfOpen: true,
    }),

);

