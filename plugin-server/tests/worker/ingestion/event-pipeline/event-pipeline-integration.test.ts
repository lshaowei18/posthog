import { PluginEvent } from '@posthog/plugin-scaffold'
import { DateTime } from 'luxon'
import { fetch } from 'undici'
import { v4 } from 'uuid'

import { MeasuringPersonsStoreForDistinctIdBatch } from '~/src/worker/ingestion/persons/measuring-person-store'

import { CookielessServerHashMode, Hook, Hub, ProjectId, Team } from '../../../../src/types'
import { closeHub, createHub } from '../../../../src/utils/db/hub'
import { PostgresUse } from '../../../../src/utils/db/postgres'
import { convertToPostIngestionEvent } from '../../../../src/utils/event'
import { parseJSON } from '../../../../src/utils/json-parse'
import { UUIDT } from '../../../../src/utils/utils'
import { ActionManager } from '../../../../src/worker/ingestion/action-manager'
import { ActionMatcher } from '../../../../src/worker/ingestion/action-matcher'
import { processWebhooksStep } from '../../../../src/worker/ingestion/event-pipeline/runAsyncHandlersStep'
import { EventPipelineRunner } from '../../../../src/worker/ingestion/event-pipeline/runner'
import { BatchWritingGroupStoreForDistinctIdBatch } from '../../../../src/worker/ingestion/groups/batch-writing-group-store'
import { HookCommander } from '../../../../src/worker/ingestion/hooks'
import { setupPlugins } from '../../../../src/worker/plugins/setup'
import { delayUntilEventIngested, resetTestDatabaseClickhouse } from '../../../helpers/clickhouse'
import { commonUserId } from '../../../helpers/plugins'
import { insertRow, resetTestDatabase } from '../../../helpers/sql'

jest.mock('../../../../src/utils/logger')

const team: Team = {
    id: 2,
    project_id: 2 as ProjectId,
    organization_id: '2',
    uuid: v4(),
    name: '2',
    anonymize_ips: true,
    api_token: 'api_token',
    slack_incoming_webhook: 'slack_incoming_webhook',
    session_recording_opt_in: true,
    person_processing_opt_out: null,
    heatmaps_opt_in: null,
    ingested_event: true,
    person_display_name_properties: null,
    test_account_filters: null,
    cookieless_server_hash_mode: null,
    timezone: 'UTC',
    available_features: [],
}

describe('Event Pipeline integration test', () => {
    let hub: Hub
    let actionManager: ActionManager
    let actionMatcher: ActionMatcher
    let hookCannon: HookCommander

    const ingestEvent = async (event: PluginEvent) => {
        const personsStore = new MeasuringPersonsStoreForDistinctIdBatch(hub.db, 'foo', event.distinct_id!)
        const groupStore = new BatchWritingGroupStoreForDistinctIdBatch(hub.db, new Map(), new Map())
        const runner = new EventPipelineRunner(hub, event, undefined, undefined, personsStore, groupStore)
        const result = await runner.runEventPipeline(event, team)
        const postIngestionEvent = convertToPostIngestionEvent(result.args[0])
        return Promise.all([processWebhooksStep(postIngestionEvent, actionMatcher, hookCannon)])
    }

    beforeEach(async () => {
        await resetTestDatabase()
        await resetTestDatabaseClickhouse()
        process.env.SITE_URL = 'https://example.com'
        hub = await createHub()

        actionManager = new ActionManager(hub.db.postgres, hub)
        await actionManager.start()
        actionMatcher = new ActionMatcher(hub.db.postgres, actionManager)
        hookCannon = new HookCommander(
            hub.db.postgres,
            hub.teamManager,
            hub.rustyHook,
            hub.appMetrics,
            hub.EXTERNAL_REQUEST_TIMEOUT_MS
        )

        jest.spyOn(hub.db, 'fetchPerson')
        jest.spyOn(hub.db, 'createPerson')
    })

    afterEach(async () => {
        await closeHub(hub)
    })

    it('handles plugins setting properties', async () => {
        await resetTestDatabase(`
            function processEvent (event) {
                event.properties = {
                    ...event.properties,
                    $browser: 'Chrome',
                    processed: 'hell yes'
                }
                event.$set = {
                    ...event.$set,
                    personProp: 'value'
                }
                return event
            }
        `)
        await setupPlugins(hub)

        const event: PluginEvent = {
            event: 'xyz',
            properties: { foo: 'bar' },
            $set: { personProp: 1, anotherValue: 2 },
            timestamp: new Date().toISOString(),
            now: new Date().toISOString(),
            team_id: 2,
            distinct_id: 'abc',
            ip: null,
            site_url: 'https://example.com',
            uuid: new UUIDT().toString(),
        }

        await ingestEvent(event)

        const events = await delayUntilEventIngested(() => hub.db.fetchEvents())
        const persons = await delayUntilEventIngested(() => hub.db.fetchPersons())

        expect(events.length).toEqual(1)
        expect(events[0]).toEqual(
            expect.objectContaining({
                uuid: event.uuid,
                event: 'xyz',
                team_id: 2,
                timestamp: DateTime.fromISO(event.timestamp!, { zone: 'utc' }),
                // :KLUDGE: Ignore properties like $plugins_succeeded, etc
                properties: expect.objectContaining({
                    foo: 'bar',
                    $browser: 'Chrome',
                    processed: 'hell yes',
                    $set: {
                        personProp: 'value',
                        anotherValue: 2,
                        $browser: 'Chrome',
                    },
                    $set_once: {
                        $initial_browser: 'Chrome',
                    },
                }),
            })
        )

        expect(persons.length).toEqual(1)
        expect(persons[0].version).toEqual(0)
        expect(persons[0].properties).toEqual({
            $creator_event_uuid: event.uuid,
            $initial_browser: 'Chrome',
            $browser: 'Chrome',
            personProp: 'value',
            anotherValue: 2,
        })
    })

    it('fires a webhook', async () => {
        await hub.db.postgres.query(
            PostgresUse.COMMON_WRITE,
            `UPDATE posthog_team SET slack_incoming_webhook = 'https://webhook.example.com/'`,
            [],
            'testTag'
        )

        const event: PluginEvent = {
            event: 'xyz',
            properties: { foo: 'bar' },
            timestamp: new Date().toISOString(),
            now: new Date().toISOString(),
            team_id: 2,
            distinct_id: 'abc',
            ip: null,
            site_url: 'not-used-anymore',
            uuid: new UUIDT().toString(),
        }
        await actionManager.reloadAllActions()

        await ingestEvent(event)

        const expectedPayload = {
            text: '[Test Action](https://example.com/project/2/action/69) was triggered by [abc](https://example.com/project/2/person/abc)',
        }

        // eslint-disable-next-line no-restricted-syntax
        const details = JSON.parse(JSON.stringify((fetch as any).mock.calls))
        expect(details[0][0]).toEqual('https://webhook.example.com/')
        expect(details[0][1]).toMatchObject({
            body: JSON.stringify(expectedPayload, undefined, 4),
            headers: { 'Content-Type': 'application/json' },
            method: 'POST',
        })
    })

    it('fires a REST hook', async () => {
        const timestamp = new Date().toISOString()

        await hub.db.postgres.query(
            PostgresUse.COMMON_WRITE,
            `UPDATE posthog_organization
                SET available_product_features = array ['{"key": "zapier", "name": "zapier"}'::jsonb]`,
            [],
            'testTag'
        )
        await insertRow(hub.db.postgres, 'ee_hook', {
            id: 'abc',
            team_id: 2,
            user_id: commonUserId,
            resource_id: 69,
            event: 'action_performed',
            target: 'https://example.com/',
            created: timestamp,
            updated: timestamp,
        } as Hook)

        const event: PluginEvent = {
            event: 'xyz',
            properties: { foo: 'bar' },
            timestamp: timestamp,
            now: timestamp,
            team_id: 2,
            distinct_id: 'abc',
            ip: null,
            site_url: 'https://example.com',
            uuid: new UUIDT().toString(),
        }
        await actionManager.reloadAllActions()

        await ingestEvent(event)

        const expectedPayload = {
            hook: {
                id: 'abc',
                event: 'action_performed',
                target: 'https://example.com/',
            },
            data: {
                event: 'xyz',
                properties: {
                    foo: 'bar',
                },
                eventUuid: expect.any(String),
                timestamp,
                teamId: 2,
                distinctId: 'abc',
                person: {
                    created_at: expect.any(String),
                    properties: {
                        $creator_event_uuid: event.uuid,
                    },
                    uuid: expect.any(String),
                },
                elementsList: [],
            },
        }

        // Using a more verbose way instead of toHaveBeenCalledWith because we need to parse request body
        // and use expect.any for a few payload properties, which wouldn't be possible in a simpler way
        expect(jest.mocked(fetch).mock.calls[0][0]).toBe('https://example.com/')
        const secondArg = jest.mocked(fetch).mock.calls[0][1]
        expect(parseJSON(secondArg!.body as unknown as string)).toEqual(expectedPayload)
        expect(secondArg!.headers).toStrictEqual({ 'Content-Type': 'application/json' })
        expect(secondArg!.method).toBe('POST')
    })

    it('single postgres action per run to create or load person', async () => {
        const event: PluginEvent = {
            event: 'xyz',
            properties: { foo: 'bar' },
            timestamp: new Date().toISOString(),
            now: new Date().toISOString(),
            team_id: 2,
            distinct_id: 'abc',
            ip: null,
            site_url: 'https://example.com',
            uuid: new UUIDT().toString(),
        }

        const personsStore = new MeasuringPersonsStoreForDistinctIdBatch(hub.db, 'foo', event.distinct_id!)
        const groupStore = new BatchWritingGroupStoreForDistinctIdBatch(hub.db, new Map(), new Map())
        await new EventPipelineRunner(hub, event, undefined, undefined, personsStore, groupStore).runEventPipeline(
            event,
            team
        )

        expect(hub.db.fetchPerson).toHaveBeenCalledTimes(1) // we query before creating
        expect(hub.db.createPerson).toHaveBeenCalledTimes(1)

        // second time single fetch
        await new EventPipelineRunner(hub, event, undefined, undefined, personsStore, groupStore).runEventPipeline(
            event,
            team
        )
        expect(hub.db.fetchPerson).toHaveBeenCalledTimes(2)

        await delayUntilEventIngested(() => hub.db.fetchEvents(), 2)
    })

    it('can process a cookieless event', async () => {
        await hub.db.postgres.query(
            PostgresUse.COMMON_WRITE,
            `UPDATE posthog_team SET cookieless_server_hash_mode = $1 WHERE id = $2`,
            [CookielessServerHashMode.Stateful, 2],
            'set team to cookieless'
        )

        const event: PluginEvent = {
            event: '$pageview',
            properties: {
                $cookieless_mode: true,
                $raw_user_agent: 'Mozilla/5.0',
                $ip: '1.2.3.4',
                $host: 'https://www.example.com',
                $timezone: 'Europe/London',
            },
            distinct_id: '$posthog_cookieless',
            timestamp: new Date().toISOString(),
            now: new Date().toISOString(),
            team_id: 2,
            ip: '1.2.3.4',
            site_url: 'https://example.com',
            uuid: new UUIDT().toString(),
        }
        const event2: PluginEvent = {
            ...event,
            uuid: new UUIDT().toString(),
        }

        // ingest 2 events from the same user
        await ingestEvent(event)
        await ingestEvent(event2)

        const events = await delayUntilEventIngested(() => hub.db.fetchEvents(), 2)
        if (events.length > 2) {
            console.log(events)
        }
        expect(events.length).toEqual(2)
        expect(events[0].distinct_id.slice(0, 11)).toEqual('cookieless_') // should have set a distict id
        expect(events[0].properties.$session_id).toBeTruthy() // should have set a session id
        expect(events[0].properties.$raw_user_agent).toBeUndefined() // should have removed personal data
        expect(events[0].distinct_id).toEqual(events[1].distinct_id) // events with the same hash should be assigned to the same user
        expect(events[0].properties.$session_id).toEqual(events[1].properties.$session_id)
    })

    it('drops cookieless event if the team has cookieless disabled', async () => {
        await hub.db.postgres.query(
            PostgresUse.COMMON_WRITE,
            `UPDATE posthog_team SET cookieless_server_hash_mode = $1 WHERE id = $2`,
            [CookielessServerHashMode.Disabled, 2],
            'set team to cookieless'
        )

        const event: PluginEvent = {
            event: '$pageview',
            properties: {
                $cookieless_mode: true,
                $raw_user_agent: 'Mozilla/5.0',
                $ip: '1.2.3.4',
                $host: 'https://www.example.com',
                $timezone: 'Europe/London',
            },
            distinct_id: '$posthog_cookieless',
            timestamp: new Date().toISOString(),
            now: new Date().toISOString(),
            team_id: 2,
            ip: '1.2.3.4',
            site_url: 'https://example.com',
            uuid: new UUIDT().toString(),
        }

        const personsStore = new MeasuringPersonsStoreForDistinctIdBatch(hub.db, 'foo', event.distinct_id!)
        const groupStore = new BatchWritingGroupStoreForDistinctIdBatch(hub.db, new Map(), new Map())
        const result = await new EventPipelineRunner(
            hub,
            event,
            undefined,
            undefined,
            personsStore,
            groupStore
        ).runEventPipeline(event, team)
        expect(result.lastStep).toEqual('cookielessServerHashStep') // rather than emitting the event
    })
})
