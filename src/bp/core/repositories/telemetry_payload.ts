import { ConfigProvider } from 'core/config/config-loader'
import { DataRetentionService } from 'core/services/retention/service'
import { inject, injectable } from 'inversify'
import Knex from 'knex'
import _ from 'lodash'
import moment from 'moment'

import Database from '../database'
import { TYPES } from '../types'

const DEFAULT_ENTRIES_LIMIT = 1000

type TelemetryEntries = {
  url: string
  events: Array<JSON>
}

type TelemetryEntry = {
  uuid: string
  payload: JSON
  available: Knex.Bool
  lastChanged: Knex.Date
  creationDate: Knex.Date
}

@injectable()
export class TelemetryRepository {
  private readonly tableName = 'telemetry'
  private readonly telemetryServerUrl = 'https://telemetry.botpress.dev'

  constructor(
    @inject(TYPES.Database) private database: Database,
    @inject(TYPES.ConfigProvider) private config: ConfigProvider
  ) {}

  async refreshAvailability(): Promise<void> {
    const time = moment()
      .subtract(5, 'minute')
      .toDate()

    const events = await this.database.knex
      .from(this.tableName)
      .select('uuid')
      .where(this.database.knex.date.isBefore('lastChanged', time))

    const uuIds = events.map(event => event.uuid)

    await this.updateAvailability(uuIds, true)
  }

  async updateAvailability(uuIds: string[], status: boolean): Promise<void> {
    if (!uuIds.length) {
      return
    }
    await this.database
      .knex(this.tableName)
      .whereIn('uuid', uuIds)
      .update({
        uuid: undefined,
        payload: undefined,
        available: this.database.knex.bool.parse(status),
        lastChanged: this.database.knex.date.now()
      })
  }

  async keepTopEntries(n: number) {
    const uuIds = await this.database.knex
      .from(this.tableName)
      .select('uuid')
      .orderBy('creationDate', 'desc')
      .limit(n)
      .then(rows => rows.map(entry => entry.uuid))

    await this.removeMany(uuIds)
  }

  async removeMany(uuIds: string[]) {
    await this.database
      .knex(this.tableName)
      .whereIn('uuid', uuIds)
      .del()
  }

  async getEntries(): Promise<TelemetryEntries> {
    const events = await this.database.knex
      .from(this.tableName)
      .select('*')
      .where('available', this.database.knex.bool.true())
      .limit(1000)

    if (events.length > 0) {
      const uuIds = events.map(event => event.uuid)
      await this.updateAvailability(uuIds, this.database.knex.bool.false())
    }
    return { url: this.telemetryServerUrl, events: events.map(event => this.database.knex.json.get(event.payload)) }
  }

  async insertPayload(uuid: string, payload: JSON) {
    const config = await this.config.getBotpressConfig()
    const limit = config.telemetry?.entriesLimit ?? DEFAULT_ENTRIES_LIMIT

    await this.keepTopEntries(limit - 1)

    await this.database.knex(this.tableName).insert({
      uuid: uuid,
      payload: this.database.knex.json.set(payload),
      available: this.database.knex.bool.true(),
      lastChanged: this.database.knex.date.now(),
      creationDate: this.database.knex.date.now()
    })
  }

  async getEntry(uuid: string): Promise<TelemetryEntry> {
    return (await this.database.knex
      .from(this.tableName)
      .select('*')
      .where('uuid', uuid)
      .then(res => {
        if (!res || !res.length) {
          throw new Error('Entity not found')
        }
        return res[0]
      })) as TelemetryEntry
  }

  async removePayload(uuid: string): Promise<void> {
    await this.database
      .knex(this.tableName)
      .where({ uuid: uuid })
      .del()
  }
}