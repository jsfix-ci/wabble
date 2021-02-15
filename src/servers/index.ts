import net from 'net';

import type { Logger } from 'pino';

import * as R from 'ramda';

import {
    monoid,
    task as T,
    taskEither as TE,
    readerTaskEither as RTE,
    readonlyMap as fpMap,
    either as E,
    option as O,
    function as F,
    string as Str,
    readonlyArray as A,
    readonlyNonEmptyArray as RNEA,
} from 'fp-ts';

import type { Remote } from '../config';
import * as u from '../utils/index';
import type { DoH_query, DNS_query, DoT_query } from 'src/utils/resolver';
import { logLevel, Resolver } from '../model';
import type { Hook } from '../services/index';

import { chain as chainHttp } from './http';
import { chain as chainSocks5 } from './socks5';
import { chain as chainTrojan } from './trojan';
import { chain as chainSS } from './shadowsocks';





type Opts = {
    host: string;
    port: number;
    hook: (...args: Parameters<Hook>) => TE.TaskEither<Error, void>;
    abort: () => void;
    resolver: Resolver;
    logger: Logger;
};

export type ChainOpts = Omit<Opts, 'resolver'>;

export type RTE_O_E_V = RTE.ReaderTaskEither<ChainOpts, Error, void>;





/*#__NOINLINE__*/
export function connect (opts: Opts, server: Remote | 'origin') {

    const { abort, hook, port } = opts;

    return F.pipe(

        /*#__NOINLINE__*/ resolve(opts),

        TE.mapLeft(R.tap(abort)),

        TE.chain(host => {

            if (server === 'origin') {
                return hook(netConnectTo({ host, port }));
            }

            return select (server) (opts);

        }),

    );

}





const isIP = O.fromPredicate(u.isIP);



const checkBlockingHost = TE.filterOrElse(
    F.not(u.isBlockedIP),
    F.constant(new u.ErrorWithCode('BLOCKED_HOST', 'Blocked via DoH or DNS')),
);



const timeoutTE = TE.left(new Error('timeout'));



const race = F.flow(
    A.compact,
    <T> (queue: readonly T[]) =>
        // bailout if only have the timeout task in queue
        queue.length < 2 ? O.none : O.some(queue.flat() as never),
    O.map(monoid.concatAll(T.getRaceMonoid<E.Either<Error, string>>())),
);





/*#__NOINLINE__*/
function resolve (opts: Opts) {

    const { host, resolver: { timeout, doh, dot, dns } } = opts;

    return F.pipe(

        isIP(host),

        O.alt(() => /*#__NOINLINE__*/ nsLookup(host)),

        O.map(TE.right),

        O.alt(() => race([
            O.some(RNEA.of(T.delay (timeout) (timeoutTE))),
            O.map (RNEA.map(/*#__NOINLINE__*/ from_DoH_DoT(opts, 'DoH'))) (doh),
            O.map (RNEA.map(/*#__NOINLINE__*/ from_DoH_DoT(opts, 'DoT'))) (dot),
            O.map (RNEA.map(/*#__NOINLINE__*/ fromDNS(opts))) (dns),
        ])),

        TE.fromOption(() => Error('No cache nor DoH, DoT or DNS')),
        TE.flatten,
        TE.alt(() => TE.right(host)),

        checkBlockingHost,

    );

}





type Query = DoH_query | DoT_query;

/*#__NOINLINE__*/
const from_DoH_DoT = (opts: Opts, type: string) => (query: Query) => {

    const { host, logger } = opts;

    return F.pipe(

        query(host),

        TE.map(/*#__NOINLINE__*/ A.findFirst(R.where({
            type: R.equals('A'),
            data: R.is(String),
        }))),

        TE.chain(TE.fromOption(() => Error('No valid entries'))),

        TE.chainFirst(({ data: ip, ttl }) => TE.fromIO(() => {

            updateCache (opts) (ip) (ttl);

            if (R.not(logLevel.on.trace)) {
                return;
            }

            logger.child({ ip }).trace(type);

        })),

        TE.map(R.prop('data')),

    );

};





/*#__NOINLINE__*/
const fromDNS = (opts: Opts) => (query: DNS_query) => {

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
const nsLookup = (host: string) => fpMap.lookup (Str.Eq) (host) (dnsCache);
const updateCache = setCache(dnsCache);
export const flushDNS = () => dnsCache.clear();





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





const unknownRemote = ({ protocol }: Remote) => {
    return new Error(`Non supported protocol [${ protocol }]`);
};

const protocolEq = R.propEq('protocol');

const select: u.Fn<Remote, RTE_O_E_V> = R.cond([
    [ protocolEq('ss'        ), chainSS ],
    [ protocolEq('http'    ), chainHttp ],
    [ protocolEq('https'   ), chainHttp ],
    [ protocolEq('socks5'), chainSocks5 ],
    [ protocolEq('trojan'), chainTrojan ],
    [ R.T, R.o(RTE.left, unknownRemote) ],
]);

