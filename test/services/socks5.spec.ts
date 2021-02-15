import http from 'http';

import {
    function as F,
    taskEither as TE,
    readerTaskEither as RTE,
    stateReaderTaskEither as SRTE,
} from 'fp-ts';

import * as R from 'ramda';

import {
    tunnel,
} from '../../src/servers/socks5';

import * as u from '../../src/utils';

import {
    genAuth,
    genEnv,
    fetchToString,
    flushHeaders,
    redirect,
    readStr,
    Result,
    temp,
    TE_ES,
} from './http.spec';





jest.retryTimes(0);





describe('socks5Proxy', () => {

    test.each([

        'socks5://   foo:bar   @   localhost   /hello   ?   c=world           ',
        'socks5://  -foo:bar   @   localhost   /hello   ?   c=world  & a & d  ',
        'socks5://                 localhost   /hello   ?   c=world           ',
        'socks5://                 localhost   /hello   ?   c=world- & e      ',

    ])('%s', async raw => {

        const env = genEnv(raw);

        const invoke = SRTE.evaluate({ proxy: 0, server: 0 });

        await u.run(R.applyTo(env, F.pipe(

            invoke(F.pipe(
                SRTE.of({}) as never,
                SRTE.apS('server', temp.server),
                SRTE.apS('proxy', temp.proxy),
                SRTE.apS('task', socks5),
            )),

            RTE.map(({ proxy, server, task }) => ({
                task,
                close () {
                    proxy.close();
                    server.close();
                },
            })),

            RTE.chain(({ close, task }) => RTE.bracket(
                RTE.of({}),
                F.constant(RTE.fromTaskEither(task)),
                F.constant(RTE.fromIO(close)),
            )),

            RTE.fold(

                error => RTE.asks(({ flags }) => {

                    if (flags.a || flags.e) {
                        return;
                    }

                    expect(error).toBeUndefined();

                }),

                content => RTE.asks(({ flags }) => {

                    expect(content).toBe(readStr(flags.c ?? ''));

                }),

            ),

        )));

    });

});





const socks5: Result<TE_ES> = ports => ({ url }) => {

    const { basic: auth } = genAuth(url);

    return TE.fromIO(() => F.tuple(F.pipe(

        u.socks5Handshake(url.hostname, ports.server),

        tunnel({ auth, host: url.hostname, port: ports.proxy }),

        TE.chain(conn => fetchToString(
            flushHeaders(
                http.request(redirect(url, ports.server), {
                    createConnection: F.constant(conn),
                }),
            ),
        )),

    ), ports));

};

