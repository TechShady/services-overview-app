/**
 * DQL query builders for the Services Overview app.
 *
 * Each timeseries / time-windowed query takes a `TF` (timeframe) argument
 * with `from` / `to` raw values plus their `expression` | `iso8601` types.
 * The selected timeframe comes from `TimeframeContext` and is applied via
 * the `tfClause` helper.
 */

import { tfClause } from "./state/TimeframeContext";
import type { TF } from "./state/TimeframeContext";

export type { TF } from "./state/TimeframeContext";

// ---------------------------------------------------------------------------
// Service list for the dropdown filter
// ---------------------------------------------------------------------------
export function serviceListQuery(): string {
  return `fetch dt.entity.service
| filter serviceType != "DATABASE_SERVICE"
| fields entity.name
| filterOut isNull(entity.name)
| sort entity.name asc
| summarize distinctServiceNames = collectDistinct(entity.name)`;
}

// ---------------------------------------------------------------------------
// Services Health — Honeycomb
// ---------------------------------------------------------------------------
export function servicesHealthQuery(problemsLookbackHours: number): string {
  return `fetch dt.entity.service
| filter serviceType != "DATABASE_SERVICE"
| lookup [
  fetch dt.davis.problems, from:now()-${problemsLookbackHours}h, to:now()
  | filter event.status == "ACTIVE"
  | expand affected_entity_ids
], sourceField:id, lookupField:affected_entity_ids
| fieldsAdd affected = if(isNotNull(lookup.affected_entity_ids), "Problem", else: "Healthy")
| fields affected, id, entity.name
| sort affected desc`;
}

// ---------------------------------------------------------------------------
// Problems List
// ---------------------------------------------------------------------------
export function problemsQuery(): string {
  return `fetch dt.davis.problems
| filter \`dt.davis.is_duplicate\` == false
| sort timestamp desc
| expand affected_entity_ids
| lookup [fetch dt.entity.service], sourceField:affected_entity_ids, lookupField: id, prefix:"lookup.affected.entity.services"
| lookup [fetch dt.entity.process_group_instance], sourceField:affected_entity_ids, lookupField: id, prefix:"lookup.affected.entity.pgi"
| lookup [fetch dt.entity.host], sourceField:affected_entity_ids, lookupField: id, prefix:"lookup.affected.entity.hosts"
| lookup [fetch dt.entity.cloud_application], sourceField:affected_entity_ids, lookupField: id, prefix:"lookup.affected.entity.cloudapplication"
| lookup [fetch dt.entity.kubernetes_cluster], sourceField:affected_entity_ids, lookupField: id, prefix:"lookup.affected.entity.kubernetescluster"
| summarize {
    startTime = takeFirst(event.start),
    endTime = takeFirst(event.end),
    problemClosedDuration = takeFirst(resolved_problem_duration),
    status = takeFirst(event.status),
    event.name = takeFirst(event.name),
    severityLevel = takeFirst(event.category),
    rootCause = takeFirst(root_cause_entity_name),
    affectedServices = collectDistinct(lookup.affected.entity.servicesentity.name),
    affectedPGI = collectDistinct(lookup.affected.entity.pgientity.name),
    affectedHosts = collectDistinct(lookup.affected.entity.hostsentity.name),
    affectedCloudApplication = collectDistinct(lookup.affected.entity.cloudapplicationentity.name),
    affectedKubernetesCluster = collectDistinct(lookup.affected.entity.kubernetesclusterentity.name),
    event.id = takeFirst(event.id)
  },
  by:{display_id, event.kind}
| fieldsAdd currentTime = toTimestamp(now())
| fieldsAdd Description = concat(display_id, " - ", event.name)
| fields Status = status,
         Description,
         Affected = arrayRemoveNulls(arrayConcat(affectedServices, affectedPGI, affectedCloudApplication, affectedKubernetesCluster, affectedHosts)),
         RootCause = if(isNotNull(rootCause), rootCause, else:""),
         StartTime = startTime,
         EndTime = if((status == "ACTIVE"), "In Progress",
                   else:if((status == "CLOSED"), endTime)),
         Duration = if((status == "CLOSED"), problemClosedDuration,
                   else:if((status == "ACTIVE"), currentTime - startTime)),
         event.id,
         event.kind
| sort StartTime, direction:"descending"
| sort Status, direction:"ascending"`;
}

// ---------------------------------------------------------------------------
// Service Details Table
// ---------------------------------------------------------------------------
export function serviceDetailsQuery(
  topN: number,
  problemsLookbackHours: number,
  tf: TF
): string {
  return `timeseries {
  latency_p50 = median(dt.service.request.response_time),
  latency_p90 = percentile(dt.service.request.response_time, 90),
  latency_p99 = percentile(dt.service.request.response_time, 99),
  requests = sum(dt.service.request.count),
  errors = sum(dt.service.request.failure_count)
}, by:{dt.entity.service}, ${tfClause(tf)}

| lookup [timeseries latency_avg = avg(dt.service.request.response_time),
         by:{dt.entity.service}, ${tfClause(tf)}],
  sourceField:dt.entity.service, lookupField:dt.entity.service, prefix:"latencyAvg."

| lookup [timeseries http_5xx = sum(dt.service.request.count, default:0.0),
         by:{dt.entity.service}, ${tfClause(tf)},
         filter:(http.response.status_code >= 500 and http.response.status_code <= 599)],
  sourceField:dt.entity.service, lookupField:dt.entity.service, prefix:"http5xx."

| lookup [timeseries http_4xx = sum(dt.service.request.count, default:0.0),
         by:{dt.entity.service}, ${tfClause(tf)},
         filter:(http.response.status_code >= 400 and http.response.status_code <= 499)],
  sourceField:dt.entity.service, lookupField:dt.entity.service, prefix:"http4xx."

| lookup [fetch dt.davis.problems, from:now()-${problemsLookbackHours}h, to:now()
         | filter event.status == "ACTIVE" and dt.davis.is_duplicate == false
         | expand affected_entity_ids
         | summarize {Problems = countDistinct(display_id),
               event.id = takeFirst(event.id)},
               by:{affected_entity_ids}],
  sourceField:dt.entity.service, lookupField:affected_entity_ids,
  fields:{Problems, event.id}

| fieldsAdd Latency_Avg = arrayAvg(latencyAvg.latency_avg),
            Latency_p50 = arrayAvg(latency_p50),
            Latency_p90 = arrayAvg(latency_p90),
            Latency_p99 = arrayAvg(latency_p99),
            Requests = arraySum(requests),
            Failures = arraySum(errors),
            \`5xx\` = arraySum(http5xx.http_5xx),
            \`4xx\` = arraySum(http4xx.http_4xx)
| fieldsAdd FailureRate = (Failures / Requests) * 100
| fieldsAdd Service = coalesce(entityName(dt.entity.service), toString(dt.entity.service))
| fields Status = if(Problems >= 0, "PROBLEM", else:"HEALTHY"),
         Service,
         dt.entity.service,
         Requests,
         Latency_Avg,
         Latency_p50,
         Latency_p90,
         Latency_p99,
         FailureRate,
         Failures,
         \`5xx\` = if(isNull(\`5xx\`), 0, else:\`5xx\`),
         \`4xx\` = if(isNull(\`4xx\`), 0, else:\`4xx\`),
         event.id
| fieldsAdd StatusSort = if(Status == "PROBLEM" and isNotNull(event.id), 0, else:1)
| sort StatusSort asc
| fieldsRemove StatusSort
| limit ${topN}`;
}

// ---------------------------------------------------------------------------
// Scorecard Previous Period (for compare)
// ---------------------------------------------------------------------------
export function scorecardPrevQuery(topN: number, tf: TF): string {
  return `timeseries {
  latency_p50 = median(dt.service.request.response_time),
  latency_p90 = percentile(dt.service.request.response_time, 90),
  requests = sum(dt.service.request.count),
  errors = sum(dt.service.request.failure_count)
}, by:{dt.entity.service}, ${tfClause(tf)}

| lookup [timeseries http_5xx = sum(dt.service.request.count, default:0.0),
         by:{dt.entity.service}, ${tfClause(tf)},
         filter:(http.response.status_code >= 500 and http.response.status_code <= 599)],
  sourceField:dt.entity.service, lookupField:dt.entity.service, prefix:"http5xx."

| fieldsAdd Latency_p50 = arrayAvg(latency_p50),
            Latency_p90 = arrayAvg(latency_p90),
            Requests = arraySum(requests),
            Failures = arraySum(errors),
            \`5xx\` = if(isNull(arraySum(http5xx.http_5xx)), 0, else:arraySum(http5xx.http_5xx))
| fieldsAdd FailureRate = (Failures / Requests) * 100
| fieldsAdd Service = coalesce(entityName(dt.entity.service), toString(dt.entity.service))
| fields Service, dt.entity.service, Requests, Latency_p50, Latency_p90, FailureRate, \`5xx\`
| limit ${topN}`;
}

// ---------------------------------------------------------------------------
// Request Details Table
// ---------------------------------------------------------------------------
export function requestDetailsQuery(topN: number, tf: TF): string {
  return `fetch spans, samplingRatio:1, scanLimitGBytes:50, ${tfClause(tf)}
| filter request.is_root_span == true AND isNotNull(endpoint.name)
| fieldsAdd sampling.probability = (power(2, 56) - coalesce(sampling.threshold, 0)) * power(2, -56),
            sampling.multiplicity = 1/sampling.probability,
            multiplicity = coalesce(sampling.multiplicity, 1) * coalesce(aggregation.count, 1) * dt.system.sampling_ratio
| fieldsAdd request.status_code = if(request.is_failed, "Failure", else:"Success")
| fieldsAdd aggregation.duration_avg = coalesce(aggregation.duration_sum/aggregation.count, duration)
| fieldsAdd dt.entity.service.entity.name = entityAttr(dt.entity.service, "entity.name")
| summarize {
    dt.entity.service = takeFirst(dt.entity.service),
    Latency_Avg = sum(aggregation.duration_avg * multiplicity) / sum(multiplicity),
    Latency_p50 = percentile(duration, 50),
    Latency_p90 = percentile(duration, 90),
    Latency_p99 = percentile(duration, 99),
    Requests = sum(multiplicity),
    Failures = sum(if(request.status_code == "Failure", multiplicity, else:0)),
    FailureRate = round(toDouble(sum(if(request.status_code == "Failure", multiplicity, else:0)) / sum(multiplicity)), decimals:3),
    \`5xx\` = sum(if(http.response.status_code >= 500 and http.response.status_code <= 599, multiplicity, else:0)),
    \`4xx\` = sum(if(http.response.status_code >= 400 and http.response.status_code <= 499, multiplicity, else:0))
  }, by:{
    dt.entity.service.entity.name,
    endpoint.name,
    dt.system.sampling_ratio
  }
| fieldsAdd Service = coalesce(entityName(dt.entity.service), toString(dt.entity.service))
| filter isNotNull(endpoint.name)
| fields Service,
         Request = endpoint.name,
         dt.entity.service,
         Requests,
         Latency_Avg,
         Latency_p50,
         Latency_p90,
         Latency_p99,
         FailureRate = FailureRate * 100,
         Failures,
         \`5xx\`,
         \`4xx\`
| sort Requests desc
| limit ${topN}`;
}

// ---------------------------------------------------------------------------
// Service Metrics — Timeseries Charts
// ---------------------------------------------------------------------------

export function requestsTotalQuery(topN: number, tf: TF): string {
  return `timeseries requests = sum(dt.service.request.count),
           by:{dt.entity.service}, ${tfClause(tf)}
| fieldsAdd service.name = coalesce(entityName(dt.entity.service), toString(dt.entity.service))
| fields timeframe, interval, service.name, dt.entity.service, requests
| sort arraySum(requests) desc
| limit ${topN}`;
}

export function latencyP50Query(topN: number, tf: TF): string {
  return `timeseries latency_p50 = percentile(dt.service.request.response_time, 50),
           by:{dt.entity.service}, ${tfClause(tf)}
| fieldsAdd service.name = coalesce(entityName(dt.entity.service), toString(dt.entity.service))
| fields timeframe, interval, service.name, dt.entity.service, latency_p50
| sort arrayAvg(latency_p50) desc
| limit ${topN}`;
}

export function latencyP90Query(topN: number, tf: TF): string {
  return `timeseries latency_p90 = percentile(dt.service.request.response_time, 90),
           by:{dt.entity.service}, ${tfClause(tf)}
| fieldsAdd service.name = coalesce(entityName(dt.entity.service), toString(dt.entity.service))
| fields timeframe, interval, service.name, dt.entity.service, latency_p90
| sort arrayAvg(latency_p90) desc
| limit ${topN}`;
}

export function failedRequestsQuery(topN: number, tf: TF): string {
  return `timeseries errors = sum(dt.service.request.failure_count, default:0),
           nonempty:true,
           by:{dt.entity.service}, ${tfClause(tf)}
| fieldsAdd service.name = coalesce(entityName(dt.entity.service), toString(dt.entity.service))
| fields timeframe, interval, service.name, dt.entity.service, errors
| sort arraySum(errors) desc
| limit ${topN}`;
}

export function failureRateQuery(topN: number, tf: TF): string {
  return `timeseries total = sum(dt.service.request.count, default:0),
           nonempty:true,
           by:{dt.entity.service}, ${tfClause(tf)}
| lookup [
  timeseries errors = sum(dt.service.request.failure_count, default:0),
           nonempty:true,
           by:{dt.entity.service}, ${tfClause(tf)}
], sourceField:dt.entity.service, lookupField:dt.entity.service, prefix:"request."
| fieldsAdd failureRate = request.errors[] / total[] * 100
| fieldsAdd service.name = coalesce(entityName(dt.entity.service), toString(dt.entity.service))
| fields timeframe, interval, service.name, dt.entity.service, failureRate
| sort arrayAvg(failureRate) desc
| limit ${topN}`;
}

export function http5xxQuery(topN: number, tf: TF): string {
  return `timeseries errors = sum(dt.service.request.count, default:0),
           nonempty:true,
           by:{dt.entity.service}, ${tfClause(tf)},
           filter: http.response.status_code >= 500 and http.response.status_code <= 599
| fieldsAdd service.name = coalesce(entityName(dt.entity.service), toString(dt.entity.service))
| fields timeframe, interval, service.name, dt.entity.service, errors
| sort arraySum(errors) desc
| limit ${topN}`;
}

export function http4xxQuery(topN: number, tf: TF): string {
  return `timeseries errors = sum(dt.service.request.count, default:0),
           nonempty:true,
           by:{dt.entity.service}, ${tfClause(tf)},
           filter: http.response.status_code >= 400 and http.response.status_code <= 499
| fieldsAdd service.name = coalesce(entityName(dt.entity.service), toString(dt.entity.service))
| fields timeframe, interval, service.name, dt.entity.service, errors
| sort arraySum(errors) desc
| limit ${topN}`;
}

export function requestsByStatusCodeQuery(topN: number, tf: TF): string {
  return `timeseries requests = sum(dt.service.request.count),
           by:{http.response.status_code}, ${tfClause(tf)}
| fields timeframe, interval, http.response.status_code, requests
| sort http.response.status_code asc
| limit ${topN}`;
}

// ---------------------------------------------------------------------------
// Process Metrics — Timeseries Charts
// ---------------------------------------------------------------------------

export function processCpuQuery(topN: number, tf: TF): string {
  return `timeseries cpu = avg(dt.process.cpu.usage),
           by:{dt.entity.process_group_instance, dt.entity.host}, ${tfClause(tf)}
| fieldsAdd pgi = coalesce(entityName(dt.entity.process_group_instance), toString(dt.entity.process_group_instance))
| fieldsAdd host.name = coalesce(entityName(dt.entity.host), toString(dt.entity.host))
| fields timeframe, interval, pgi, dt.entity.process_group_instance, host.name, cpu
| sort arrayAvg(cpu) desc
| limit ${topN}`;
}

export function processMemoryPercentQuery(topN: number, tf: TF): string {
  return `timeseries memory = avg(dt.process.memory.usage),
           by:{dt.entity.process_group_instance, dt.entity.host}, ${tfClause(tf)}
| fieldsAdd pgi = coalesce(entityName(dt.entity.process_group_instance), toString(dt.entity.process_group_instance))
| fieldsAdd host.name = coalesce(entityName(dt.entity.host), toString(dt.entity.host))
| fields timeframe, interval, pgi, dt.entity.process_group_instance, host.name, memory
| sort arrayAvg(memory) desc
| limit ${topN}`;
}

export function processMemoryUsedQuery(topN: number, tf: TF): string {
  return `timeseries memory = avg(dt.process.memory.working_set_size),
           by:{dt.entity.process_group_instance, dt.entity.host}, ${tfClause(tf)}
| fieldsAdd pgi = coalesce(entityName(dt.entity.process_group_instance), toString(dt.entity.process_group_instance))
| fieldsAdd host.name = coalesce(entityName(dt.entity.host), toString(dt.entity.host))
| fields timeframe, interval, pgi, dt.entity.process_group_instance, host.name, memory
| sort arrayAvg(memory) desc
| limit ${topN}`;
}

export function processGcTimeQuery(topN: number, tf: TF): string {
  return `timeseries gc_time = avg(dt.runtime.jvm.gc.suspension_time),
           by:{dt.entity.process_group_instance, dt.entity.host}, ${tfClause(tf)}
| append [timeseries gc_time = avg(dt.runtime.clr.gc.suspension_time),
           by:{dt.entity.process_group_instance, dt.entity.host}, ${tfClause(tf)}]
| append [timeseries gc_time = avg(dt.runtime.go.gc.suspension_time),
           by:{dt.entity.process_group_instance, dt.entity.host}, ${tfClause(tf)}]
| append [timeseries gc_time = avg(dt.runtime.nodejs.gc.suspension_time),
           by:{dt.entity.process_group_instance, dt.entity.host}, ${tfClause(tf)}]
| fieldsAdd pgi = coalesce(entityName(dt.entity.process_group_instance), toString(dt.entity.process_group_instance))
| fieldsAdd host.name = coalesce(entityName(dt.entity.host), toString(dt.entity.host))
| fields timeframe, interval, pgi, dt.entity.process_group_instance, host.name, gc_time
| sort arrayAvg(gc_time) desc
| limit ${topN}`;
}

// ---------------------------------------------------------------------------
// K8s Workload Metrics — Timeseries Charts
// ---------------------------------------------------------------------------

export function k8sCpuQuery(topN: number, tf: TF): string {
  return `timeseries cpu = avg(dt.kubernetes.container.cpu_usage),
           limits = avg(dt.kubernetes.container.limits_cpu),
           by:{k8s.namespace.name, dt.entity.kubernetes_cluster, dt.entity.cloud_application_namespace, dt.entity.cloud_application},
           ${tfClause(tf)}
| fieldsAdd workload = coalesce(entityName(dt.entity.cloud_application), toString(dt.entity.cloud_application))
| fields timeframe, interval, workload, cpu, limits, dt.entity.cloud_application, k8s.namespace.name
| sort arrayAvg(cpu) desc
| limit ${topN}`;
}

export function k8sMemoryQuery(topN: number, tf: TF): string {
  return `timeseries memory = avg(dt.kubernetes.container.memory_working_set),
           limits = avg(dt.kubernetes.container.limits_memory),
           by:{k8s.namespace.name, dt.entity.kubernetes_cluster, dt.entity.cloud_application_namespace, dt.entity.cloud_application},
           ${tfClause(tf)}
| fieldsAdd workload = coalesce(entityName(dt.entity.cloud_application), toString(dt.entity.cloud_application))
| fields timeframe, interval, workload, memory, limits, dt.entity.cloud_application, k8s.namespace.name
| sort arrayAvg(memory) desc
| limit ${topN}`;
}

export function k8sCpuPrevQuery(topN: number, tf: TF): string {
  return k8sCpuQuery(topN, tf);
}

export function k8sMemoryPrevQuery(topN: number, tf: TF): string {
  return k8sMemoryQuery(topN, tf);
}

// ---------------------------------------------------------------------------
// Host Right-Sizing — CPU & Memory
// ---------------------------------------------------------------------------
export function hostCpuQuery(topN: number, tf: TF): string {
  return `timeseries cpu = avg(dt.host.cpu.usage),
           by:{dt.entity.host}, ${tfClause(tf)}
| fieldsAdd host = coalesce(entityName(dt.entity.host), toString(dt.entity.host))
| fields timeframe, interval, host, cpu, dt.entity.host
| sort arrayAvg(cpu) desc
| limit ${topN}`;
}

export function hostMemoryQuery(topN: number, tf: TF): string {
  return `timeseries memory = avg(dt.host.memory.usage),
           by:{dt.entity.host}, ${tfClause(tf)}
| fieldsAdd host = coalesce(entityName(dt.entity.host), toString(dt.entity.host))
| fields timeframe, interval, host, memory, dt.entity.host
| sort arrayAvg(memory) desc
| limit ${topN}`;
}

// ---------------------------------------------------------------------------
// Database Service Details — for Right-Sizing
// ---------------------------------------------------------------------------
export function databaseDetailsQuery(topN: number, tf: TF): string {
  return `timeseries {
  requests = sum(dt.service.request.count),
  errors = sum(dt.service.request.failure_count),
  latency_avg = avg(dt.service.request.response_time),
  latency_p90 = percentile(dt.service.request.response_time, 90)
}, by:{dt.entity.service}, ${tfClause(tf)}
| lookup [fetch dt.entity.service
  | filter serviceType == "DATABASE_SERVICE"
  | fields id, serviceType], sourceField:dt.entity.service, lookupField:id, prefix:"db."
| filter isNotNull(db.serviceType)
| fieldsAdd Service = coalesce(entityName(dt.entity.service), toString(dt.entity.service))
| fieldsAdd Requests = arraySum(requests),
            Failures = arraySum(errors),
            Latency_Avg = arrayAvg(latency_avg),
            Latency_p90 = arrayAvg(latency_p90)
| fieldsAdd FailureRate = if(Requests > 0, (Failures / Requests) * 100, else:0.0)
| fields Service, dt.entity.service, Requests, Latency_Avg, Latency_p90, FailureRate, Failures
| sort Requests desc
| limit ${topN}`;
}

// ---------------------------------------------------------------------------
// Timeseries conversion helper
// ---------------------------------------------------------------------------
export interface TimeseriesPoint {
  start: Date;
  end: Date;
  value: number;
}

export interface ChartTimeseries {
  datapoints: TimeseriesPoint[];
  name: string;
  unit?: string;
}

export function toTimeseries(
  records: Array<Record<string, unknown>> | null | undefined,
  metricField: string,
  nameField: string = "service.name",
  unit?: string
): ChartTimeseries[] {
  if (!records || records.length === 0) return [];
  return records.map((r) => {
    const timeframes = r.timeframe as Array<{ start: string; end: string }>;
    const values = r[metricField] as number[];
    const label = r[nameField] as string;
    return {
      name: label ?? "Unknown",
      unit,
      datapoints: (timeframes ?? []).map((tf, i) => ({
        start: new Date(tf.start),
        end: new Date(tf.end),
        value: values?.[i] ?? 0,
      })),
    };
  });
}

export function toProcessTimeseries(
  records: Array<Record<string, unknown>> | null | undefined,
  metricField: string
): ChartTimeseries[] {
  if (!records || records.length === 0) return [];
  return records.map((r) => {
    const timeframes = r.timeframe as Array<{ start: string; end: string }>;
    const values = r[metricField] as number[];
    const pgi = r.pgi as string;
    const host = r["host.name"] as string;
    return {
      name: `${pgi ?? "Unknown"} @ ${host ?? ""}`,
      datapoints: (timeframes ?? []).map((tf, i) => ({
        start: new Date(tf.start),
        end: new Date(tf.end),
        value: values?.[i] ?? 0,
      })),
    };
  });
}

export function toK8sTimeseries(
  records: Array<Record<string, unknown>> | null | undefined,
  metricField: string
): ChartTimeseries[] {
  if (!records || records.length === 0) return [];
  return records.map((r) => {
    const timeframes = r.timeframe as Array<{ start: string; end: string }>;
    const values = r[metricField] as number[];
    const workload = r.workload as string;
    const ns = r["k8s.namespace.name"] as string;
    return {
      name: `${workload ?? "Unknown"} (${ns ?? ""})`,
      datapoints: (timeframes ?? []).map((tf, i) => ({
        start: new Date(tf.start),
        end: new Date(tf.end),
        value: values?.[i] ?? 0,
      })),
    };
  });
}

// ---------------------------------------------------------------------------
// Deployment Events
// ---------------------------------------------------------------------------
export function deploymentEventsQuery(tf: TF): string {
  return `fetch events, ${tfClause(tf)}
| filter event.type == "CUSTOM_DEPLOYMENT"
| fieldsAdd serviceName = coalesce(entityName(dt.entity.service), toString(dt.entity.service))
| fields timestamp, event.name, serviceName, dt.entity.service, event.type
| sort timestamp desc
| limit 200`;
}

// Change Impact — hourly service metrics for correlating with deployments
export function changeImpactMetricsQuery(tf: TF): string {
  return `timeseries {
  requests = sum(dt.service.request.count),
  failures = sum(dt.service.request.failure_count, default:0),
  latency_p90 = percentile(dt.service.request.response_time, 90)
}, by:{dt.entity.service}, interval:1h, ${tfClause(tf)}
| fieldsAdd Service = coalesce(entityName(dt.entity.service), toString(dt.entity.service))
| fields Service, dt.entity.service, timeframe, requests, failures, latency_p90`;
}

// Apdex — per-service satisfaction breakdown from spans
export function apdexQuery(tf: TF, thresholdMs: number): string {
  const fourT = thresholdMs * 4;
  return `fetch spans, samplingRatio:1, scanLimitGBytes:50, ${tfClause(tf)}
| filter isNotNull(dt.entity.service)
| fieldsAdd Service = coalesce(entityName(dt.entity.service), toString(dt.entity.service)),
  satisfaction = if(duration <= ${thresholdMs}ms, "satisfied", else: if(duration <= ${fourT}ms, "tolerating", else: "frustrated"))
| summarize count = count(), by:{Service, dt.entity.service, satisfaction}`;
}

export function apdexPrevQuery(tf: TF, thresholdMs: number): string {
  return apdexQuery(tf, thresholdMs);
}

// ---------------------------------------------------------------------------
// Service Entity Types — lightweight map of entity ID → serviceType
// Used to gate Smartscape drilldown links for DATABASE_SERVICE / MESSAGING_SERVICE
// ---------------------------------------------------------------------------
export function serviceEntityTypesQuery(): string {
  return `fetch dt.entity.service
| fields id, serviceType, dbDevice = runs[\`dt.entity.custom_device\`]
| limit 5000`;
}

// ---------------------------------------------------------------------------
// Service Dependencies
// ---------------------------------------------------------------------------
export function serviceDependenciesQuery(): string {
  return `fetch dt.entity.service
| filter serviceType != "DATABASE_SERVICE"
| fieldsAdd calledServices = calls[\`dt.entity.service\`]
| filter isNotNull(calledServices)
| expand calledServices
| fieldsAdd Caller = entity.name, CallerId = id, Callee = coalesce(entityName(calledServices, type:"dt.entity.service"), toString(calledServices)), CalleeId = toString(calledServices)
| filter isNotNull(Callee)
| fields Caller, CallerId, Callee, CalleeId
| sort Caller asc`;
}

// ---------------------------------------------------------------------------
// Problems Summary (for prev-period KPI comparison)
// ---------------------------------------------------------------------------
export function problemsPrevSummaryQuery(tf: TF): string {
  return `fetch dt.davis.problems, ${tfClause(tf)}
| filter dt.davis.is_duplicate == false
| expand affected_entity_ids
| lookup [fetch dt.entity.service], sourceField:affected_entity_ids, lookupField:id, prefix:"svc."
| summarize problemCount = countDistinct(display_id), affectedServiceCount = countDistinct(svc.id)`;
}

// ---------------------------------------------------------------------------
// MTTR / MTTA — Closed Problems
// ---------------------------------------------------------------------------
export function closedProblemsQuery(tf: TF): string {
  return `fetch dt.davis.problems, ${tfClause(tf)}
| filter dt.davis.is_duplicate == false AND event.status == "CLOSED"
| fields display_id, event.id, event.name, event.start, event.end, resolved_problem_duration, management_zones, root_cause_entity_name
| fieldsAdd computed_duration_ns = if(isNotNull(event.end) AND isNotNull(event.start), toLong(event.end - event.start), else: 0)
| fieldsAdd effective_duration_ns = if(isNotNull(resolved_problem_duration) AND toLong(resolved_problem_duration) > 0, toLong(resolved_problem_duration), else: computed_duration_ns)
| fieldsAdd duration_minutes = toDouble(effective_duration_ns) / 60000000000.0
| sort event.start desc
| limit 500`;
}

// ---------------------------------------------------------------------------
// Anomaly Detection
// ---------------------------------------------------------------------------
export function anomalyCurrentQuery(tf: TF): string {
  return `timeseries {
  requests = sum(dt.service.request.count),
  errors = sum(dt.service.request.failure_count),
  latency_p90 = percentile(dt.service.request.response_time, 90)
}, by:{dt.entity.service}, ${tfClause(tf)}
| fieldsAdd Service = coalesce(entityName(dt.entity.service), toString(dt.entity.service))
| fieldsAdd avgRequests = arrayAvg(requests), totalErrors = arraySum(errors), totalRequests = arraySum(requests)
| fieldsAdd avgLatencyP90 = arrayAvg(latency_p90)
| fieldsAdd errorRate = if(totalRequests > 0, totalErrors / totalRequests * 100, else:0.0)
| fields Service, dt.entity.service, avgRequests, totalErrors, totalRequests, avgLatencyP90, errorRate`;
}

export function anomalyBaselineQuery(tf: TF): string {
  return anomalyCurrentQuery(tf);
}

// ---------------------------------------------------------------------------
// Comparison Mode — Previous Period Timeseries
//
// Each *PrevQuery delegates to the corresponding "current" query — the
// caller is responsible for passing the previous-period TF (typically
// computed from `previousPeriod()` in TimeframeContext).
// ---------------------------------------------------------------------------
export function requestsTotalPrevQuery(topN: number, tf: TF): string {
  return requestsTotalQuery(topN, tf);
}

export function latencyP90PrevQuery(topN: number, tf: TF): string {
  return latencyP90Query(topN, tf);
}

export function failureRatePrevQuery(topN: number, tf: TF): string {
  return failureRateQuery(topN, tf);
}

export function http5xxPrevQuery(topN: number, tf: TF): string {
  return http5xxQuery(topN, tf);
}

export function latencyP50PrevQuery(topN: number, tf: TF): string {
  return latencyP50Query(topN, tf);
}

export function failedRequestsPrevQuery(topN: number, tf: TF): string {
  return failedRequestsQuery(topN, tf);
}

export function requestsByStatusCodePrevQuery(topN: number, tf: TF): string {
  return requestsByStatusCodeQuery(topN, tf);
}

export function http4xxPrevQuery(topN: number, tf: TF): string {
  return http4xxQuery(topN, tf);
}

// ---------------------------------------------------------------------------
// Comparison Mode — Previous Period Process Metrics
// ---------------------------------------------------------------------------
export function processCpuPrevQuery(topN: number, tf: TF): string {
  return processCpuQuery(topN, tf);
}

export function processMemoryPercentPrevQuery(topN: number, tf: TF): string {
  return processMemoryPercentQuery(topN, tf);
}

export function processMemoryUsedPrevQuery(topN: number, tf: TF): string {
  return processMemoryUsedQuery(topN, tf);
}

export function processGcTimePrevQuery(topN: number, tf: TF): string {
  return processGcTimeQuery(topN, tf);
}

// ---------------------------------------------------------------------------
// Service Metrics — Percentile Comparison (P75 + P99)
// ---------------------------------------------------------------------------
export function latencyP75Query(topN: number, tf: TF): string {
  return `timeseries latency_p75 = percentile(dt.service.request.response_time, 75),
           by:{dt.entity.service}, ${tfClause(tf)}
| fieldsAdd service.name = coalesce(entityName(dt.entity.service), toString(dt.entity.service))
| fields timeframe, interval, service.name, dt.entity.service, latency_p75
| sort arrayAvg(latency_p75) desc
| limit ${topN}`;
}

export function latencyP99TimeseriesQuery(topN: number, tf: TF): string {
  return `timeseries latency_p99 = percentile(dt.service.request.response_time, 99),
           by:{dt.entity.service}, ${tfClause(tf)}
| fieldsAdd service.name = coalesce(entityName(dt.entity.service), toString(dt.entity.service))
| fields timeframe, interval, service.name, dt.entity.service, latency_p99
| sort arrayAvg(latency_p99) desc
| limit ${topN}`;
}

// ---------------------------------------------------------------------------
// Process Restart Events
// ---------------------------------------------------------------------------
export function processRestartEventsQuery(tf: TF): string {
  return `fetch events, ${tfClause(tf)}
| filter event.kind == "DAVIS_EVENT" AND event.type == "PROCESS_RESTART"
| fields timestamp, event.name, dt.entity.process_group_instance, dt.entity.host
| fieldsAdd pgi = coalesce(entityName(dt.entity.process_group_instance), toString(dt.entity.process_group_instance))
| fieldsAdd host = coalesce(entityName(dt.entity.host), toString(dt.entity.host))
| sort timestamp desc
| limit 200`;
}

// ---------------------------------------------------------------------------
// K8s HPA Scaling Events
// ---------------------------------------------------------------------------
export function k8sHpaEventsQuery(tf: TF): string {
  return `fetch events, ${tfClause(tf)}
| filter event.kind == "K8S_EVENT" AND matchesPhrase(content, "scaled")
| fields timestamp, content, dt.entity.cloud_application, k8s.namespace.name
| fieldsAdd workload = coalesce(entityName(dt.entity.cloud_application), toString(dt.entity.cloud_application))
| sort timestamp desc
| limit 100`;
}

// ---------------------------------------------------------------------------
// K8s Pod Eviction & OOMKill Events
// ---------------------------------------------------------------------------
export function k8sPodEvictionQuery(tf: TF): string {
  return `fetch events, ${tfClause(tf)}
| filter event.kind == "K8S_EVENT" AND (matchesPhrase(content, "OOMKilled") OR matchesPhrase(content, "Evicted") OR matchesPhrase(content, "OOMKill") OR event.type == "POD_EVICTION")
| fields timestamp, content, dt.entity.cloud_application, k8s.namespace.name, k8s.pod.name
| fieldsAdd workload = coalesce(entityName(dt.entity.cloud_application), toString(dt.entity.cloud_application))
| sort timestamp desc
| limit 200`;
}

// ---------------------------------------------------------------------------
// K8s Node Resource Pressure
// ---------------------------------------------------------------------------
export function k8sNodePressureQuery(tf: TF): string {
  return `timeseries {
  cpu = avg(dt.kubernetes.container.cpu_usage),
  cpu_limits = avg(dt.kubernetes.container.limits_cpu),
  memory = avg(dt.kubernetes.container.memory_working_set),
  memory_limits = avg(dt.kubernetes.container.limits_memory)
}, by:{k8s.node.name}, ${tfClause(tf)}
| filter isNotNull(k8s.node.name)
| fieldsAdd avg_cpu = arrayAvg(cpu), avg_cpu_limit = arrayAvg(cpu_limits),
            avg_memory = arrayAvg(memory), avg_memory_limit = arrayAvg(memory_limits)
| fieldsAdd cpu_pct = if(avg_cpu_limit > 0, avg_cpu / avg_cpu_limit * 100, else:0.0),
            memory_pct = if(avg_memory_limit > 0, avg_memory / avg_memory_limit * 100, else:0.0)
| fields node = k8s.node.name, cpu_pct, memory_pct
| sort cpu_pct desc
| limit 50`;
}

// ---------------------------------------------------------------------------
// K8s Namespace Rollup — CPU & Memory per namespace
// ---------------------------------------------------------------------------
export function k8sNamespaceRollupQuery(tf: TF): string {
  return `timeseries {
  cpu = avg(dt.kubernetes.container.cpu_usage),
  memory = avg(dt.kubernetes.container.memory_working_set)
}, by:{k8s.namespace.name}, ${tfClause(tf)}
| fieldsAdd avg_cpu = arrayAvg(cpu), avg_memory = arrayAvg(memory)
| fields k8s.namespace.name, avg_cpu, avg_memory
| sort avg_cpu desc
| limit 50`;
}

// ---------------------------------------------------------------------------
// Service Ownership — dt.owner tag from entity metadata
// ---------------------------------------------------------------------------
export function serviceOwnershipQuery(): string {
  return `fetch dt.entity.service
| filter serviceType != "DATABASE_SERVICE"
| fields id, entity.name, owner = tags[dt.owner]
| filter isNotNull(owner)
| limit 5000`;
}

// ---------------------------------------------------------------------------
// Request P99 Baseline — previous period P99 for anomaly flagging
// ---------------------------------------------------------------------------
export function requestBaselineQuery(topN: number, tf: TF): string {
  return `fetch spans, samplingRatio:1, scanLimitGBytes:50, ${tfClause(tf)}
| filter request.is_root_span == true AND isNotNull(endpoint.name)
| fieldsAdd sampling.probability = (power(2, 56) - coalesce(sampling.threshold, 0)) * power(2, -56),
            sampling.multiplicity = 1/sampling.probability,
            multiplicity = coalesce(sampling.multiplicity, 1) * coalesce(aggregation.count, 1) * dt.system.sampling_ratio
| summarize {
    Latency_p99 = percentile(duration, 99)
  }, by:{
    dt.entity.service,
    endpoint.name
  }
| fields dt.entity.service, endpoint.name, Latency_p99
| limit ${topN}`;
}

// ---------------------------------------------------------------------------
// Request Error Category Breakdown — 4xx vs 5xx vs timeout per endpoint
// ---------------------------------------------------------------------------
export function requestErrorBreakdownQuery(topN: number, tf: TF): string {
  return `fetch spans, samplingRatio:1, scanLimitGBytes:50, ${tfClause(tf)}
| filter request.is_root_span == true AND isNotNull(endpoint.name) AND request.is_failed == true
| fieldsAdd sampling.probability = (power(2, 56) - coalesce(sampling.threshold, 0)) * power(2, -56),
            sampling.multiplicity = 1/sampling.probability,
            multiplicity = coalesce(sampling.multiplicity, 1) * coalesce(aggregation.count, 1) * dt.system.sampling_ratio
| fieldsAdd error_category = if(http.response.status_code >= 500 AND http.response.status_code <= 599, "5xx",
              else: if(http.response.status_code >= 400 AND http.response.status_code <= 499, "4xx",
              else: if(duration >= 30000000000, "timeout", else: "other")))
| summarize {
    count = sum(multiplicity)
  }, by:{
    dt.entity.service,
    endpoint.name,
    error_category
  }
| fields dt.entity.service, endpoint.name, error_category, count
| limit ${topN}`;
}

// ---------------------------------------------------------------------------
// Multi-Window Burn Rate — error rates for 1h, 6h, 24h, 72h windows
// ---------------------------------------------------------------------------
export function burnRateWindowQuery(windowHours: number): string {
  return `timeseries {
  requests = sum(dt.service.request.count),
  errors = sum(dt.service.request.failure_count)
}, by:{dt.entity.service}, from:now()-${windowHours}h, to:now()
| fieldsAdd Service = coalesce(entityName(dt.entity.service), toString(dt.entity.service)),
            totalReqs = arraySum(requests),
            totalErrs = arraySum(errors)
| fieldsAdd errorRate = if(totalReqs > 0, (totalErrs / totalReqs) * 100, else: 0.0)
| fields Service, dt.entity.service, errorRate, totalReqs
| filter totalReqs > 0
| sort errorRate desc
| limit 200`;
}

// ---------------------------------------------------------------------------
// Endpoint Heatmap — Hourly breakdown for last 7 days (for heatmap grid)
// ---------------------------------------------------------------------------
export function endpointHourlyHeatmapQuery(tf: TF): string {
  return `timeseries {
  requests = sum(dt.service.request.count),
  errors = sum(dt.service.request.failure_count),
  latencyP50 = median(dt.service.request.response_time),
  latencyP90 = percentile(dt.service.request.response_time, 90),
  latencyP99 = percentile(dt.service.request.response_time, 99)
}, by:{dt.entity.service}, interval:1h, ${tfClause(tf)}
| fieldsAdd Service = coalesce(entityName(dt.entity.service), toString(dt.entity.service))
| fields timeframe, interval, Service, dt.entity.service, requests, errors, latencyP50, latencyP90, latencyP99
| limit 5000`;
}

// ---------------------------------------------------------------------------
// Endpoint Heatmap — Previous week baseline for 2σ anomaly detection
// ---------------------------------------------------------------------------
export function endpointPrevWeekHeatmapQuery(): string {
  return `timeseries {
  requests = sum(dt.service.request.count),
  errors = sum(dt.service.request.failure_count),
  latencyP50 = median(dt.service.request.response_time),
  latencyP90 = percentile(dt.service.request.response_time, 90),
  latencyP99 = percentile(dt.service.request.response_time, 99)
}, by:{dt.entity.service}, interval:1h, from:now()-14d, to:now()-7d
| fieldsAdd Service = coalesce(entityName(dt.entity.service), toString(dt.entity.service))
| fields timeframe, interval, Service, dt.entity.service, requests, errors, latencyP50, latencyP90, latencyP99
| limit 5000`;
}

// ---------------------------------------------------------------------------
// K8s Clusters — summary with resource metrics
// ---------------------------------------------------------------------------
export function k8sClustersQuery(tf: TF): string {
  return `timeseries {
  cpu = avg(dt.kubernetes.container.cpu_usage),
  cpu_limits = avg(dt.kubernetes.container.limits_cpu),
  memory = avg(dt.kubernetes.container.memory_working_set),
  memory_limits = avg(dt.kubernetes.container.limits_memory)
}, by:{dt.entity.kubernetes_cluster}, ${tfClause(tf)}
| fieldsAdd cluster = coalesce(entityName(dt.entity.kubernetes_cluster), toString(dt.entity.kubernetes_cluster))
| fieldsAdd avg_cpu = arrayAvg(cpu), avg_cpu_limit = arrayAvg(cpu_limits),
            avg_memory = arrayAvg(memory), avg_memory_limit = arrayAvg(memory_limits)
| fieldsAdd cpu_pct = if(avg_cpu_limit > 0, avg_cpu / avg_cpu_limit * 100, else:0.0),
            memory_pct = if(avg_memory_limit > 0, avg_memory / avg_memory_limit * 100, else:0.0)
| fields cluster, dt.entity.kubernetes_cluster, avg_cpu, cpu_pct, avg_memory, memory_pct
| sort cpu_pct desc
| limit 50`;
}

// ---------------------------------------------------------------------------
// K8s Nodes — node resource utilization
// ---------------------------------------------------------------------------
export function k8sNodesQuery(tf: TF): string {
  return `timeseries {
  cpu = avg(dt.kubernetes.container.cpu_usage),
  cpu_limits = avg(dt.kubernetes.container.limits_cpu),
  memory = avg(dt.kubernetes.container.memory_working_set),
  memory_limits = avg(dt.kubernetes.container.limits_memory)
}, by:{k8s.node.name}, ${tfClause(tf)}
| filter isNotNull(k8s.node.name)
| fieldsAdd avg_cpu = arrayAvg(cpu), avg_cpu_limit = arrayAvg(cpu_limits),
            avg_memory = arrayAvg(memory), avg_memory_limit = arrayAvg(memory_limits)
| fieldsAdd cpu_pct = if(avg_cpu_limit > 0, avg_cpu / avg_cpu_limit * 100, else:0.0),
            memory_pct = if(avg_memory_limit > 0, avg_memory / avg_memory_limit * 100, else:0.0)
| fields node = k8s.node.name, cpu_pct, memory_pct
| sort cpu_pct desc
| limit 200`;
}

// ---------------------------------------------------------------------------
// K8s Namespaces — resource usage per namespace
// ---------------------------------------------------------------------------
export function k8sNamespacesQuery(tf: TF): string {
  return `timeseries {
  cpu = avg(dt.kubernetes.container.cpu_usage),
  cpu_limits = avg(dt.kubernetes.container.limits_cpu),
  memory = avg(dt.kubernetes.container.memory_working_set),
  memory_limits = avg(dt.kubernetes.container.limits_memory),
  restarts = sum(dt.kubernetes.container.restarts)
}, by:{k8s.namespace.name}, ${tfClause(tf)}
| fieldsAdd avg_cpu = arrayAvg(cpu), avg_cpu_limit = arrayAvg(cpu_limits),
            avg_memory = arrayAvg(memory), avg_memory_limit = arrayAvg(memory_limits),
            total_restarts = arraySum(restarts)
| fieldsAdd cpu_pct = if(avg_cpu_limit > 0, avg_cpu / avg_cpu_limit * 100, else:0.0),
            memory_pct = if(avg_memory_limit > 0, avg_memory / avg_memory_limit * 100, else:0.0)
| fields k8s.namespace.name, avg_cpu, cpu_pct, avg_memory, memory_pct, total_restarts
| sort cpu_pct desc
| limit 200`;
}

// ---------------------------------------------------------------------------
// K8s Services — service entity listing with metrics
// ---------------------------------------------------------------------------
export function k8sServicesQuery(tf: TF): string {
  return `timeseries {
  cpu = avg(dt.kubernetes.container.cpu_usage),
  cpu_limits = avg(dt.kubernetes.container.limits_cpu),
  memory = avg(dt.kubernetes.container.memory_working_set),
  memory_limits = avg(dt.kubernetes.container.limits_memory)
}, by:{dt.entity.cloud_application, k8s.namespace.name}, ${tfClause(tf)}
| fieldsAdd service = coalesce(entityName(dt.entity.cloud_application), toString(dt.entity.cloud_application))
| fieldsAdd avg_cpu = arrayAvg(cpu), avg_cpu_limit = arrayAvg(cpu_limits),
            avg_memory = arrayAvg(memory), avg_memory_limit = arrayAvg(memory_limits)
| fieldsAdd cpu_pct = if(avg_cpu_limit > 0, avg_cpu / avg_cpu_limit * 100, else:0.0),
            memory_pct = if(avg_memory_limit > 0, avg_memory / avg_memory_limit * 100, else:0.0)
| fields service, dt.entity.cloud_application, k8s.namespace.name, avg_cpu, cpu_pct, avg_memory, memory_pct
| sort cpu_pct desc
| limit 200`;
}

// ---------------------------------------------------------------------------
// K8s Pods — pod status and restarts
// ---------------------------------------------------------------------------
export function k8sPodsQuery(tf: TF): string {
  return `timeseries {
  restarts = sum(dt.kubernetes.container.restarts),
  cpu = avg(dt.kubernetes.container.cpu_usage),
  cpu_limits = avg(dt.kubernetes.container.limits_cpu),
  memory = avg(dt.kubernetes.container.memory_working_set),
  memory_limits = avg(dt.kubernetes.container.limits_memory)
}, by:{k8s.pod.name, k8s.namespace.name}, ${tfClause(tf)}
| fieldsAdd total_restarts = arraySum(restarts), avg_cpu = arrayAvg(cpu), avg_cpu_limit = arrayAvg(cpu_limits),
            avg_memory = arrayAvg(memory), avg_memory_limit = arrayAvg(memory_limits)
| fieldsAdd cpu_pct = if(avg_cpu_limit > 0, avg_cpu / avg_cpu_limit * 100, else:0.0),
            memory_pct = if(avg_memory_limit > 0, avg_memory / avg_memory_limit * 100, else:0.0)
| fields k8s.pod.name, k8s.namespace.name, avg_cpu, cpu_pct, avg_memory, memory_pct, total_restarts
| sort total_restarts desc
| limit 200`;
}

// ---------------------------------------------------------------------------
// K8s Containers — container-level resource usage
// ---------------------------------------------------------------------------
export function k8sContainersQuery(tf: TF): string {
  return `timeseries {
  cpu = avg(dt.kubernetes.container.cpu_usage),
  cpu_limits = avg(dt.kubernetes.container.limits_cpu),
  memory = avg(dt.kubernetes.container.memory_working_set),
  memory_limits = avg(dt.kubernetes.container.limits_memory)
}, by:{k8s.container.name, k8s.pod.name, k8s.namespace.name}, ${tfClause(tf)}
| fieldsAdd avg_cpu = arrayAvg(cpu), avg_cpu_limit = arrayAvg(cpu_limits),
            avg_memory = arrayAvg(memory), avg_memory_limit = arrayAvg(memory_limits)
| fieldsAdd cpu_pct = if(avg_cpu_limit > 0, avg_cpu / avg_cpu_limit * 100, else:0.0),
            memory_pct = if(avg_memory_limit > 0, avg_memory / avg_memory_limit * 100, else:0.0)
| fields k8s.container.name, k8s.pod.name, k8s.namespace.name, avg_cpu, cpu_pct, avg_memory, memory_pct
| sort cpu_pct desc
| limit 200`;
}

// ---------------------------------------------------------------------------
// Host → Service Map — maps services to the hosts they run on (via PGIs)
// ---------------------------------------------------------------------------
export function hostServiceMapQuery(): string {
  return `fetch dt.entity.service
| fields serviceName = entity.name, pgis = runs_on[dt.entity.process_group_instance]
| expand pgi = pgis
| lookup [fetch dt.entity.process_group_instance | fields id, hostId = belongs_to[dt.entity.host]], sourceField:pgi, lookupField:id, prefix:"pgi."
| lookup [fetch dt.entity.host | fields id, entity.name], sourceField:pgi.hostId, lookupField:id, prefix:"host."
| fields serviceName, hostName = host.entity.name, hostId = host.id
| filterOut isNull(hostName) OR isNull(serviceName)
| dedup serviceName, hostName`;
}

// ---------------------------------------------------------------------------
// K8s Workload ↔ Service Map — Service → PG → cloud_application (workload)
// ---------------------------------------------------------------------------
export function k8sWorkloadServiceMapQuery(): string {
  return `fetch dt.entity.service
| fields serviceName = entity.name, pgs = runs_on[dt.entity.process_group]
| expand pg = pgs
| lookup [fetch dt.entity.process_group | fieldsAdd caId = belongs_to[dt.entity.cloud_application] | fields id, caId], sourceField:pg, lookupField:id, prefix:"pg."
| filter isNotNull(pg.caId)
| expand caId = pg.caId
| lookup [fetch dt.entity.cloud_application | fields id, entity.name], sourceField:caId, lookupField:id, prefix:"ca."
| filter isNotNull(ca.entity.name)
| fields serviceName, workloadName = ca.entity.name, workloadId = ca.id
| filterOut isNull(serviceName) OR isNull(workloadName)
| dedup serviceName, workloadName`;
}

// ---------------------------------------------------------------------------
// K8s Cluster → Workload Map — traverse K8S_CLUSTER → K8S_NAMESPACE → workload types
// Avoids timeseries row-count cap; uses smartscape topology (confirmed edge types)
// ---------------------------------------------------------------------------
export function k8sClusterWorkloadMapQuery(): string {
  return `smartscapeNodes K8S_DEPLOYMENT
| fields workloadId = id, workloadName = k8s.workload.name, clusterName = k8s.cluster.name
| filter isNotNull(workloadName) AND isNotNull(clusterName)
| append [smartscapeNodes K8S_DAEMONSET | fields workloadId = id, workloadName = k8s.workload.name, clusterName = k8s.cluster.name | filter isNotNull(workloadName) AND isNotNull(clusterName)]
| append [smartscapeNodes K8S_STATEFULSET | fields workloadId = id, workloadName = k8s.workload.name, clusterName = k8s.cluster.name | filter isNotNull(workloadName) AND isNotNull(clusterName)]
| dedup workloadName, clusterName
| limit 10000`;
}

// ---------------------------------------------------------------------------
// K8s Node → Workload Map — maps nodes to their workloads via timeseries co-occurrence
// ---------------------------------------------------------------------------
export function k8sNodeWorkloadMapQuery(): string {
  return `timeseries avg(dt.kubernetes.container.cpu_usage), by:{dt.entity.kubernetes_node, dt.entity.cloud_application}, from:now()-2h
| fieldsAdd nodeName = entityName(dt.entity.kubernetes_node), workloadName = entityName(dt.entity.cloud_application)
| filter isNotNull(nodeName) AND isNotNull(workloadName)
| fields nodeName, workloadName, nodeId = dt.entity.kubernetes_node, workloadId = dt.entity.cloud_application
| dedup nodeName, workloadName`;
}

// ---------------------------------------------------------------------------
// K8s Workload Entity Map — maps workload names to K8S_DEPLOYMENT/DAEMONSET/STATEFULSET IDs
// ---------------------------------------------------------------------------
export function k8sWorkloadEntityMapQuery(): string {
  return `smartscapeNodes K8S_DEPLOYMENT
| fields id, name = k8s.workload.name, namespace = k8s.namespace.name, kind = "Deployment"
| append [smartscapeNodes K8S_DAEMONSET | fields id, name = k8s.workload.name, namespace = k8s.namespace.name, kind = "DaemonSet"]
| append [smartscapeNodes K8S_STATEFULSET | fields id, name = k8s.workload.name, namespace = k8s.namespace.name, kind = "StatefulSet"]`;
}

// ---------------------------------------------------------------------------
// K8s Cluster Entity Map — maps cluster names to K8S_CLUSTER IDs
// ---------------------------------------------------------------------------
export function k8sClusterEntityMapQuery(): string {
  return `smartscapeNodes K8S_CLUSTER
| fields id, name = k8s.cluster.name`;
}

// ---------------------------------------------------------------------------
// Cloud Region → Cluster Map — clusters grouped by cloud region (AWS/Azure/GCP)
// ---------------------------------------------------------------------------
export function cloudRegionClusterQuery(): string {
  return `smartscapeNodes K8S_CLUSTER
| fields clusterId = id, clusterName = name, region = aws.availability_zone
| filter isNotNull(region) AND isNotNull(clusterName)
| append [smartscapeNodes K8S_CLUSTER | fields clusterId = id, clusterName = name, region = aws.region | filter isNotNull(region) AND isNotNull(clusterName)]
| append [smartscapeNodes K8S_CLUSTER | fields clusterId = id, clusterName = name, region = azure.location | filter isNotNull(region) AND isNotNull(clusterName)]
| append [smartscapeNodes K8S_CLUSTER | fields clusterId = id, clusterName = name, region = azure.region | filter isNotNull(region) AND isNotNull(clusterName)]
| append [smartscapeNodes K8S_CLUSTER | fields clusterId = id, clusterName = name, region = gcp.region | filter isNotNull(region) AND isNotNull(clusterName)]
| dedup clusterName, region
| limit 1000`;
}

// ---------------------------------------------------------------------------
// Cloud Region → Host Map — aws.availability_zone, azure.location/region, gcp.region
// Uses entity display name (name) to match hostServiceMapQuery which joins on entity.name
// ---------------------------------------------------------------------------
export function cloudRegionHostQuery(): string {
  return `smartscapeNodes HOST
| fields hostId = id, hostName = name, region = aws.availability_zone
| filter isNotNull(region) AND isNotNull(hostName)
| append [smartscapeNodes HOST | fields hostId = id, hostName = name, region = azure.location | filter isNotNull(region) AND isNotNull(hostName)]
| append [smartscapeNodes HOST | fields hostId = id, hostName = name, region = azure.region | filter isNotNull(region) AND isNotNull(hostName)]
| append [smartscapeNodes HOST | fields hostId = id, hostName = name, region = gcp.region | filter isNotNull(region) AND isNotNull(hostName)]
| dedup hostName, region
| limit 10000`;
}

// ---------------------------------------------------------------------------
// Cloud Region → Process Map — maps hosts to their running process group instances
// ---------------------------------------------------------------------------
export function cloudRegionProcessQuery(): string {
  return `fetch dt.entity.process_group_instance
| fields pgiName = entity.name, hostId = belongs_to[dt.entity.host]
| lookup [fetch dt.entity.host | fields id, hostName = entity.name], sourceField:hostId, lookupField:id, prefix:"host."
| fields pgiName, hostName = host.hostName
| filterOut isNull(hostName) OR isNull(pgiName)
| dedup pgiName, hostName
| limit 5000`;
}

// ---------------------------------------------------------------------------
// Cloud Region → Lambda Map — AWS Lambda functions by region
// ---------------------------------------------------------------------------
export function cloudRegionLambdaQuery(): string {
  return `fetch dt.entity.aws_lambda_function
| fields lambdaName = entity.name, region = aws.region
| filterOut isNull(region) OR isNull(lambdaName)
| dedup lambdaName, region
| limit 1000`;
}

// ---------------------------------------------------------------------------
// Container → Process Map — processes running inside each container group instance
// ---------------------------------------------------------------------------
export function cloudRegionContainerProcessQuery(): string {
  return `fetch dt.entity.process_group_instance
| fields pgiName = entity.name,
         containerId = belongs_to[dt.entity.container_group_instance],
         hostId = belongs_to[dt.entity.host]
| filter isNotNull(containerId)
| lookup [fetch dt.entity.container_group_instance | fields id, containerName = entity.name], sourceField:containerId, lookupField:id, prefix:"cgi."
| lookup [fetch dt.entity.host | fields id, hostName = entity.name], sourceField:hostId, lookupField:id, prefix:"host."
| fields pgiName, containerName = cgi.containerName, hostName = host.hostName
| filterOut isNull(containerName) OR isNull(pgiName)
| dedup pgiName, containerName
| limit 5000`;
}

// ---------------------------------------------------------------------------
// Cloud Region → Azure Function App Map — Azure Function Apps by azure.location
// ---------------------------------------------------------------------------
export function cloudRegionAzureFunctionQuery(): string {
  return `fetch dt.entity.azure_function_app
| fields funcName = entity.name, region = azure.location
| filterOut isNull(region) OR isNull(funcName)
| dedup funcName, region
| limit 1000`;
}

// ---------------------------------------------------------------------------
// Host → Containers Map — container group instances belonging to hosts
// ---------------------------------------------------------------------------
export function cloudRegionContainerQuery(): string {
  return `fetch dt.entity.container_group_instance
| fields containerName = entity.name, hostId = belongs_to[dt.entity.host]
| lookup [fetch dt.entity.host | fields id, hostName = entity.name], sourceField:hostId, lookupField:id, prefix:"host."
| fields containerName, hostName = host.hostName
| filterOut isNull(hostName) OR isNull(containerName)
| dedup containerName, hostName
| limit 5000`;
}

// ---------------------------------------------------------------------------
// K8s Node Entity Map — maps node names to K8S_NODE IDs
// ---------------------------------------------------------------------------
export function k8sNodeEntityMapQuery(): string {
  return `smartscapeNodes K8S_NODE
| fields id, name = k8s.node.name`;
}

// ---------------------------------------------------------------------------
// K8s Namespace Entity Map — maps namespace names to K8S_NAMESPACE IDs
// ---------------------------------------------------------------------------
export function k8sNamespaceEntityMapQuery(): string {
  return `smartscapeNodes K8S_NAMESPACE
| fields id, name = k8s.namespace.name`;
}

// ---------------------------------------------------------------------------
// K8s Namespace → Workload Map — maps namespaces to their workloads via timeseries co-occurrence
// ---------------------------------------------------------------------------
export function k8sNamespaceWorkloadMapQuery(): string {
  return `timeseries avg(dt.kubernetes.container.cpu_usage), by:{k8s.namespace.name, dt.entity.cloud_application}, from:now()-2h
| fieldsAdd workloadName = entityName(dt.entity.cloud_application)
| filter isNotNull(k8s.namespace.name) AND isNotNull(workloadName)
| fields namespaceName = k8s.namespace.name, workloadName, workloadId = dt.entity.cloud_application
| dedup namespaceName, workloadName`;
}

// ---------------------------------------------------------------------------
// K8s Pod → Workload Map — maps pods to their workloads with replica counts
// ---------------------------------------------------------------------------
export function k8sPodWorkloadMapQuery(): string {
  return `timeseries avg(dt.kubernetes.container.cpu_usage), by:{k8s.pod.name, k8s.namespace.name, dt.entity.cloud_application}, from:now()-2h
| fieldsAdd workloadName = entityName(dt.entity.cloud_application)
| filter isNotNull(k8s.pod.name) AND isNotNull(workloadName)
| fields podName = k8s.pod.name, namespaceName = k8s.namespace.name, workloadName, workloadId = dt.entity.cloud_application
| dedup podName, workloadName`;
}

// ---------------------------------------------------------------------------
// K8s Container → Pod → Workload Map (for container blast radius)
// ---------------------------------------------------------------------------
export function k8sContainerPodWorkloadMapQuery(): string {
  return `timeseries avg(dt.kubernetes.container.cpu_usage), by:{k8s.container.name, k8s.pod.name, k8s.namespace.name, dt.entity.cloud_application}, from:now()-2h
| fieldsAdd workloadName = entityName(dt.entity.cloud_application)
| filter isNotNull(k8s.container.name) AND isNotNull(k8s.pod.name) AND isNotNull(workloadName)
| fields containerName = k8s.container.name, podName = k8s.pod.name, namespaceName = k8s.namespace.name, workloadName, workloadId = dt.entity.cloud_application
| dedup containerName, podName`;
}

// ---------------------------------------------------------------------------
// K8s Service Entity Map — maps service names to K8S_SERVICE IDs
// ---------------------------------------------------------------------------
export function k8sServiceEntityMapQuery(): string {
  return `smartscapeNodes K8S_SERVICE
| fields id, name = k8s.service.name`;
}

// ---------------------------------------------------------------------------
// K8s Pod Entity Map — maps pod names to K8S_POD IDs
// ---------------------------------------------------------------------------
export function k8sPodEntityMapQuery(): string {
  return `smartscapeNodes K8S_POD
| fields id, name = k8s.pod.name
| limit 10000`;
}

// ---------------------------------------------------------------------------
// K8s Container Entity Map — maps container names (with pod) to CONTAINER IDs
// ---------------------------------------------------------------------------
export function k8sContainerEntityMapQuery(): string {
  return `smartscapeNodes CONTAINER
| fields id, name = k8s.container.name, pod = k8s.pod.name
| limit 10000`;
}

// ---------------------------------------------------------------------------
// MTTR — All closed problems for env-wide benchmark
// ---------------------------------------------------------------------------
export function mttrAllServicesQuery(): string {
  return `fetch dt.davis.problems, from:now()-30d, to:now()
| filter event.status == "CLOSED"
| fields dt.entity.service = arrayFirst(affected_entity_ids),
         duration_minutes = (event.end - event.start) / 60000000000,
         root_cause_entity_name, display_id, event.name, event.start, event.end
| filter isNotNull(duration_minutes) AND duration_minutes > 0
| limit 1000`;
}

// ---------------------------------------------------------------------------
// MTTR — Repeat offenders (same root cause entity recurring)
// ---------------------------------------------------------------------------
export function mttrRepeatOffendersQuery(): string {
  return `fetch dt.davis.problems, from:now()-30d, to:now()
| filter event.status == "CLOSED"
| fields root_cause_entity_name, display_id, event.name, event.start,
         duration_minutes = (event.end - event.start) / 60000000000
| filter isNotNull(root_cause_entity_name) AND root_cause_entity_name != ""
| summarize occurrences = count(), avgDuration = avg(duration_minutes),
            lastSeen = last(event.start), problems = collectDistinct(display_id),
            by:{root_cause_entity_name}
| filter occurrences >= 2
| sort occurrences desc
| limit 10`;
}

// ---------------------------------------------------------------------------
// Change Impact — P50 + P99 + throughput for side-by-side comparison cards
// ---------------------------------------------------------------------------
export function changeImpactDetailedQuery(tf: TF): string {
  return `timeseries {
  requests = sum(dt.service.request.count),
  failures = sum(dt.service.request.failure_count, default:0),
  latency_p50 = median(dt.service.request.response_time),
  latency_p90 = percentile(dt.service.request.response_time, 90),
  latency_p99 = percentile(dt.service.request.response_time, 99)
}, by:{dt.entity.service}, interval:1h, ${tfClause(tf)}
| fieldsAdd Service = coalesce(entityName(dt.entity.service), toString(dt.entity.service))
| fields Service, dt.entity.service, timeframe, requests, failures, latency_p50, latency_p90, latency_p99`;
}

// ---------------------------------------------------------------------------
// Apdex — geographic segmentation (from span geo attributes)
// ---------------------------------------------------------------------------
export function apdexGeoQuery(tf: TF, thresholdMs: number): string {
  const fourT = thresholdMs * 4;
  return `fetch spans, samplingRatio:1, scanLimitGBytes:50, ${tfClause(tf)}
| filter isNotNull(dt.entity.service)
| fieldsAdd region = if(isNotNull(net.host.geo.region), net.host.geo.region,
                     else: if(isNotNull(server.geo.region), server.geo.region,
                     else: if(isNotNull(client.geo.region), client.geo.region, else: "Unknown")))
| fieldsAdd satisfaction = if(duration <= ${thresholdMs}ms, "satisfied", else: if(duration <= ${fourT}ms, "tolerating", else: "frustrated"))
| summarize count = count(), by:{region, satisfaction}
| filter region != "Unknown"
| limit 500`;
}

// ---------------------------------------------------------------------------
// Apdex — user cohort segmentation (mobile/desktop, internal/external)
// ---------------------------------------------------------------------------
export function apdexCohortQuery(tf: TF, thresholdMs: number): string {
  const fourT = thresholdMs * 4;
  return `fetch spans, samplingRatio:1, scanLimitGBytes:50, ${tfClause(tf)}
| filter isNotNull(dt.entity.service)
| fieldsAdd userAgent = if(isNotNull(http.user_agent), http.user_agent, else: "unknown")
| fieldsAdd cohort = if(matchesPhrase(userAgent, "Mobile") OR matchesPhrase(userAgent, "Android") OR matchesPhrase(userAgent, "iPhone"), "Mobile",
                     else: if(matchesPhrase(userAgent, "internal") OR matchesPhrase(userAgent, "service-mesh"), "Internal",
                     else: "Desktop"))
| fieldsAdd satisfaction = if(duration <= ${thresholdMs}ms, "satisfied", else: if(duration <= ${fourT}ms, "tolerating", else: "frustrated"))
| summarize count = count(), by:{cohort, satisfaction}
| limit 100`;
}


// ---------------------------------------------------------------------------
// Reliability Trend — period-specific failure rate query
// ---------------------------------------------------------------------------
export function reliabilityTrendQuery(tf: TF): string {
  return `timeseries {
  requests = sum(dt.service.request.count),
  errors = sum(dt.service.request.failure_count)
}, by:{dt.entity.service}, ${tfClause(tf)}
| fieldsAdd FailureRate = if(arraySum(requests) > 0, (arraySum(errors) / arraySum(requests)) * 100.0, else: 0.0)
| fields Service = coalesce(entityName(dt.entity.service), toString(dt.entity.service)), FailureRate
| sort FailureRate desc`;
}

// ---------------------------------------------------------------------------
// Flame Graph — span distribution by operation for a selected service
// ---------------------------------------------------------------------------
export function flameGraphQuery(serviceName: string, tf: TF): string {
  return `fetch spans, samplingRatio:1, scanLimitGBytes:50, ${tfClause(tf)}
| filter entityAttr(dt.entity.service, "entity.name") == "${serviceName}"
| summarize {
    count = count(),
    total_duration = sum(duration),
    avg_duration = avg(duration),
    p50 = percentile(duration, 50),
    p90 = percentile(duration, 90),
    p99 = percentile(duration, 99),
    errors = countIf(request.is_failed == true)
  }, by: {
    operation = coalesce(endpoint.name, "unknown"),
    kind = coalesce(span.kind, "internal")
  }
| sort total_duration desc
| limit 50`;
}

// ---------------------------------------------------------------------------
// Services With Spans — distinct list for flame graph service dropdown
// ---------------------------------------------------------------------------
export function servicesWithSpansQuery(tf: TF): string {
  return `fetch spans, samplingRatio:1, scanLimitGBytes:50, ${tfClause(tf)}
| filter isNotNull(dt.entity.service)
| summarize spanCount = count(), by:{dt.entity.service}
| filter spanCount > 0
| fieldsAdd Service = coalesce(entityAttr(dt.entity.service, "entity.name"), toString(dt.entity.service))
| fields Service, spanCount
| sort spanCount desc
| limit 1000`;
}

// ---------------------------------------------------------------------------
// N+1 Query Anti-Pattern — DB spans issued per parent span (database fan-out)
// Matches Pattern Problems app approach: count db.system spans under each parent.
// ---------------------------------------------------------------------------
export function n1QueryPatternQuery(tf: TF): string {
  return `fetch spans, samplingRatio:1, scanLimitGBytes:50, ${tfClause(tf)}
| filter isNotNull(trace.id) AND isNotNull(parent.span.id) AND isNotNull(db.system)
| summarize db_count = count(),
    service_id = takeFirst(dt.entity.service),
    db_system = takeFirst(db.system),
    by:{trace.id, parent.span.id}
| filter db_count >= 5
| summarize
    pattern_count = count(),
    total_spans = sum(db_count),
    avg_queries = avg(db_count),
    max_siblings = max(db_count),
    by:{service_id, db = db_system}
| fieldsAdd Service = coalesce(entityAttr(service_id, "entity.name", type:"dt.entity.service"), toString(service_id))
| sort total_spans desc
| limit 100`;
}

// ---------------------------------------------------------------------------
// Circular Dependency — services appearing multiple times in the same trace.
// Matches Pattern Problems "Circular Dependencies" tab approach.
// ---------------------------------------------------------------------------
export function circularDependencySpanQuery(tf: TF): string {
  return `fetch spans, samplingRatio:1, scanLimitGBytes:50, ${tfClause(tf)}
| filter isNotNull(trace.id) AND isNotNull(dt.entity.service)
| fieldsAdd service_name = coalesce(entityAttr(dt.entity.service, "entity.name"), toString(dt.entity.service))
| summarize visit_count = count(), by:{trace.id, service_name}
| filter visit_count > 1
| summarize circular_traces = count(), avg_revisits = avg(visit_count), max_revisits = max(visit_count), by:{service = service_name}
| filter circular_traces >= 10
| sort circular_traces desc
| limit 100`;
}
