import { Queue } from "bullmq";
import SuperJSON from "superjson";
import type { Address } from "thirdweb";
import { getConfig } from "../../shared/utils/cache/get-config";
import { redis } from "../../shared/utils/redis/redis";
import { defaultJobOptions } from "./queues";

// Each job handles a block range for a given chain, filtered by addresses + events.
export type EnqueueProcessEventLogsData = {
  chainId: number;
  filters: {
    address: Address;
    events: string[];
  }[];
  fromBlock: number; // inclusive
  toBlock: number; // inclusive
};

export class ProcessEventsLogQueue {
  static q = new Queue<string>("process-event-logs", {
    connection: redis,
    defaultJobOptions,
  });

  static add = async (data: EnqueueProcessEventLogsData) => {
    const serialized = SuperJSON.stringify(data);
    // e.g. 8453:14423125-14423685
    const jobName = `${data.chainId}:${data.fromBlock}-${data.toBlock}`;
    const { contractSubscriptionsRequeryDelaySeconds } = await getConfig();
    const requeryDelays = contractSubscriptionsRequeryDelaySeconds.split(",");

    // Enqueue one job immediately and any delayed jobs.
    await this.q.add(jobName, serialized);

    // The last attempt should attempt repeatedly to handle extended RPC issues.
    // This backoff attempts at intervals:
    // 30s, 1m, 2m, 4m, 8m, 16m, 32m, ~1h, ~2h, ~4h
    for (let i = 0; i < requeryDelays.length; i++) {
      const delay = Number.parseInt(requeryDelays[i]) * 1000;
      const attempts = i === requeryDelays.length - 1 ? 10 : 0;
      await this.q.add(jobName, serialized, {
        delay,
        attempts,
        backoff: { type: "exponential", delay: 30_000 },
      });
    }
  };
}
