import { Hub, LogLevel } from '../../../src/types'
import { closeHub, createHub } from '../../../src/utils/db/hub'
import { captureIngestionWarning } from '../../../src/worker/ingestion/utils'
import { delayUntilEventIngested, resetTestDatabaseClickhouse } from '../../helpers/clickhouse'

jest.setTimeout(60000) // 60 sec timeout

describe('captureIngestionWarning()', () => {
    let hub: Hub

    beforeEach(async () => {
        hub = await createHub({ LOG_LEVEL: LogLevel.Info })
        await resetTestDatabaseClickhouse()
    })

    afterEach(async () => {
        await closeHub(hub)
    })

    async function fetchWarnings() {
        const { data } = await hub.db.clickhouseQuery('SELECT * FROM ingestion_warnings')
        return data
    }

    it('can read own writes', async () => {
        await captureIngestionWarning(hub.db.kafkaProducer, 2, 'some_type', { foo: 'bar' })

        const warnings = await delayUntilEventIngested(fetchWarnings)
        expect(warnings).toEqual([
            expect.objectContaining({
                team_id: 2,
                source: 'plugin-server',
                type: 'some_type',
                details: '{"foo":"bar"}',
                timestamp: expect.any(String),
                _timestamp: expect.any(String),
            }),
        ])
    })
})
