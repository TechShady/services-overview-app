/**
 * DQL query builders for the Services Overview app.
 *
 * Adapted from the "Services Overview" dashboard.
 * All timeseries queries accept optional service filters and timeframe.
 */

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
  timeframeDays: number
): string {
  return `timeseries {
  latency_p50 = median(dt.service.request.response_time),
  latency_p90 = percentile(dt.service.request.response_time, 90),
  latency_p99 = percentile(dt.service.request.response_time, 99),
  requests = sum(dt.service.request.count),
  errors = sum(dt.service.request.failure_count)
}, by:{dt.entity.service}, from:-${timeframeDays}d

| lookup [timeseries latency_avg = avg(dt.service.request.response_time),
         by:{dt.entity.service}, from:-${timeframeDays}d],
  sourceField:dt.entity.service, lookupField:dt.entity.service, prefix:"latencyAvg."

| lookup [timeseries http_5xx = sum(dt.service.request.count, default:0.0),
         by:{dt.entity.service}, from:-${timeframeDays}d,
         filter:(http.response.status_code >= 500 and http.response.status_code <= 599)],
  sourceField:dt.entity.service, lookupField:dt.entity.service, prefix:"http5xx."

| lookup [timeseries http_4xx = sum(dt.service.request.count, default:0.0),
         by:{dt.entity.service}, from:-${timeframeDays}d,
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
| fieldsAdd Service = entityName(dt.entity.service)
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
// Request Details Table
// ---------------------------------------------------------------------------
export function requestDetailsQuery(topN: number, timeframeDays: number): string {
  return `fetch spans, samplingRatio:1, scanLimitGBytes:50, from:-${timeframeDays}d
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
| fieldsAdd Service = entityName(dt.entity.service)
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

export function requestsTotalQuery(topN: number, timeframeDays: number): string {
  return `timeseries requests = sum(dt.service.request.count),
           by:{dt.entity.service}, from:-${timeframeDays}d
| fieldsAdd service.name = entityName(dt.entity.service)
| fields timeframe, interval, service.name, dt.entity.service, requests
| sort arraySum(requests) desc
| limit ${topN}`;
}

export function latencyP50Query(topN: number, timeframeDays: number): string {
  return `timeseries latency_p50 = percentile(dt.service.request.response_time, 50),
           by:{dt.entity.service}, from:-${timeframeDays}d
| fieldsAdd service.name = entityName(dt.entity.service)
| fields timeframe, interval, service.name, dt.entity.service, latency_p50
| sort arrayAvg(latency_p50) desc
| limit ${topN}`;
}

export function latencyP90Query(topN: number, timeframeDays: number): string {
  return `timeseries latency_p90 = percentile(dt.service.request.response_time, 90),
           by:{dt.entity.service}, from:-${timeframeDays}d
| fieldsAdd service.name = entityName(dt.entity.service)
| fields timeframe, interval, service.name, dt.entity.service, latency_p90
| sort arrayAvg(latency_p90) desc
| limit ${topN}`;
}

export function failedRequestsQuery(topN: number, timeframeDays: number): string {
  return `timeseries errors = sum(dt.service.request.failure_count, default:0),
           nonempty:true,
           by:{dt.entity.service}, from:-${timeframeDays}d
| fieldsAdd service.name = entityName(dt.entity.service)
| fields timeframe, interval, service.name, dt.entity.service, errors
| sort arraySum(errors) desc
| limit ${topN}`;
}

export function failureRateQuery(topN: number, timeframeDays: number): string {
  return `timeseries total = sum(dt.service.request.count, default:0),
           nonempty:true,
           by:{dt.entity.service}, from:-${timeframeDays}d
| lookup [
  timeseries errors = sum(dt.service.request.failure_count, default:0),
           nonempty:true,
           by:{dt.entity.service}, from:-${timeframeDays}d
], sourceField:dt.entity.service, lookupField:dt.entity.service, prefix:"request."
| fieldsAdd failureRate = request.errors[] / total[] * 100
| fieldsAdd service.name = entityName(dt.entity.service)
| fields timeframe, interval, service.name, dt.entity.service, failureRate
| sort arrayAvg(failureRate) desc
| limit ${topN}`;
}

export function http5xxQuery(topN: number, timeframeDays: number): string {
  return `timeseries errors = sum(dt.service.request.count, default:0),
           nonempty:true,
           by:{dt.entity.service}, from:-${timeframeDays}d,
           filter: http.response.status_code >= 500 and http.response.status_code <= 599
| fieldsAdd service.name = entityName(dt.entity.service)
| fields timeframe, interval, service.name, dt.entity.service, errors
| sort arraySum(errors) desc
| limit ${topN}`;
}

export function http4xxQuery(topN: number, timeframeDays: number): string {
  return `timeseries errors = sum(dt.service.request.count, default:0),
           nonempty:true,
           by:{dt.entity.service}, from:-${timeframeDays}d,
           filter: http.response.status_code >= 400 and http.response.status_code <= 499
| fieldsAdd service.name = entityName(dt.entity.service)
| fields timeframe, interval, service.name, dt.entity.service, errors
| sort arraySum(errors) desc
| limit ${topN}`;
}

export function requestsByStatusCodeQuery(topN: number, timeframeDays: number): string {
  return `timeseries requests = sum(dt.service.request.count),
           by:{http.response.status_code}, from:-${timeframeDays}d
| fields timeframe, interval, http.response.status_code, requests
| sort http.response.status_code asc
| limit ${topN}`;
}

// ---------------------------------------------------------------------------
// Process Metrics — Timeseries Charts
// ---------------------------------------------------------------------------

export function processCpuQuery(topN: number, timeframeDays: number): string {
  return `timeseries cpu = avg(dt.process.cpu.usage),
           by:{dt.entity.process_group_instance, dt.entity.host}, from:-${timeframeDays}d
| fieldsAdd pgi = entityName(dt.entity.process_group_instance)
| fieldsAdd host.name = entityName(dt.entity.host)
| fields timeframe, interval, pgi, dt.entity.process_group_instance, host.name, cpu
| sort arrayAvg(cpu) desc
| limit ${topN}`;
}

export function processMemoryPercentQuery(topN: number, timeframeDays: number): string {
  return `timeseries memory = avg(dt.process.memory.usage),
           by:{dt.entity.process_group_instance, dt.entity.host}, from:-${timeframeDays}d
| fieldsAdd pgi = entityName(dt.entity.process_group_instance)
| fieldsAdd host.name = entityName(dt.entity.host)
| fields timeframe, interval, pgi, dt.entity.process_group_instance, host.name, memory
| sort arrayAvg(memory) desc
| limit ${topN}`;
}

export function processMemoryUsedQuery(topN: number, timeframeDays: number): string {
  return `timeseries memory = avg(dt.process.memory.working_set_size),
           by:{dt.entity.process_group_instance, dt.entity.host}, from:-${timeframeDays}d
| fieldsAdd pgi = entityName(dt.entity.process_group_instance)
| fieldsAdd host.name = entityName(dt.entity.host)
| fields timeframe, interval, pgi, dt.entity.process_group_instance, host.name, memory
| sort arrayAvg(memory) desc
| limit ${topN}`;
}

export function processGcTimeQuery(topN: number, timeframeDays: number): string {
  return `timeseries gc_time = avg(dt.runtime.jvm.gc.suspension_time),
           by:{dt.entity.process_group_instance, dt.entity.host}, from:-${timeframeDays}d
| append [timeseries gc_time = avg(dt.runtime.clr.gc.suspension_time),
           by:{dt.entity.process_group_instance, dt.entity.host}, from:-${timeframeDays}d]
| append [timeseries gc_time = avg(dt.runtime.go.gc.suspension_time),
           by:{dt.entity.process_group_instance, dt.entity.host}, from:-${timeframeDays}d]
| append [timeseries gc_time = avg(dt.runtime.nodejs.gc.suspension_time),
           by:{dt.entity.process_group_instance, dt.entity.host}, from:-${timeframeDays}d]
| fieldsAdd pgi = entityName(dt.entity.process_group_instance)
| fieldsAdd host.name = entityName(dt.entity.host)
| fields timeframe, interval, pgi, dt.entity.process_group_instance, host.name, gc_time
| sort arrayAvg(gc_time) desc
| limit ${topN}`;
}

// ---------------------------------------------------------------------------
// K8s Workload Metrics — Timeseries Charts
// ---------------------------------------------------------------------------

export function k8sCpuQuery(topN: number, timeframeDays: number): string {
  return `timeseries cpu = avg(dt.kubernetes.container.cpu_usage),
           by:{k8s.namespace.name, dt.entity.kubernetes_cluster, dt.entity.cloud_application_namespace, dt.entity.cloud_application},
           from:-${timeframeDays}d
| fieldsAdd workload = entityName(dt.entity.cloud_application)
| fields timeframe, interval, workload, cpu, dt.entity.cloud_application, k8s.namespace.name
| sort arrayAvg(cpu) desc
| limit ${topN}`;
}

export function k8sMemoryQuery(topN: number, timeframeDays: number): string {
  return `timeseries memory = avg(dt.kubernetes.container.memory_working_set),
           limits = avg(dt.kubernetes.container.limits_memory),
           by:{k8s.namespace.name, dt.entity.kubernetes_cluster, dt.entity.cloud_application_namespace, dt.entity.cloud_application},
           from:-${timeframeDays}d
| fieldsAdd workload = entityName(dt.entity.cloud_application)
| fields timeframe, interval, workload, memory, limits, dt.entity.cloud_application, k8s.namespace.name
| sort arrayAvg(memory) desc
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
export function deploymentEventsQuery(timeframeDays: number): string {
  return `fetch events, from:-${timeframeDays}d
| filter event.type == "CUSTOM_DEPLOYMENT"
| fieldsAdd serviceName = entityName(dt.entity.service)
| fields timestamp, event.name, serviceName, dt.entity.service, event.type
| sort timestamp desc
| limit 200`;
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
| fieldsAdd Caller = entity.name, Callee = entityName(calledServices, type:"dt.entity.service")
| filter isNotNull(Callee)
| fields Caller, Callee
| sort Caller asc`;
}

// ---------------------------------------------------------------------------
// MTTR / MTTA — Closed Problems
// ---------------------------------------------------------------------------
export function closedProblemsQuery(timeframeDays: number): string {
  return `fetch dt.davis.problems, from:-${timeframeDays}d
| filter dt.davis.is_duplicate == false AND event.status == "CLOSED"
| fields display_id, event.name, event.start, event.end, resolved_problem_duration, management_zones, root_cause_entity_name
| fieldsAdd duration_minutes = toDouble(resolved_problem_duration) / 60000.0
| sort event.start desc
| limit 500`;
}

// ---------------------------------------------------------------------------
// Anomaly Detection
// ---------------------------------------------------------------------------
export function anomalyCurrentQuery(timeframeDays: number): string {
  return `timeseries {
  requests = sum(dt.service.request.count),
  errors = sum(dt.service.request.failure_count),
  latency_p90 = percentile(dt.service.request.response_time, 90)
}, by:{dt.entity.service}, from:-${timeframeDays}d
| fieldsAdd Service = entityName(dt.entity.service)
| fieldsAdd avgRequests = arrayAvg(requests), totalErrors = arraySum(errors), totalRequests = arraySum(requests)
| fieldsAdd avgLatencyP90 = arrayAvg(latency_p90)
| fieldsAdd errorRate = if(totalRequests > 0, totalErrors / totalRequests * 100, else:0.0)
| fields Service, dt.entity.service, avgRequests, totalErrors, totalRequests, avgLatencyP90, errorRate`;
}

export function anomalyBaselineQuery(timeframeDays: number): string {
  const baselineDays = Math.max(timeframeDays * 4, 30);
  return `timeseries {
  requests = sum(dt.service.request.count),
  errors = sum(dt.service.request.failure_count),
  latency_p90 = percentile(dt.service.request.response_time, 90)
}, by:{dt.entity.service}, from:-${baselineDays}d, to:-${timeframeDays}d
| fieldsAdd Service = entityName(dt.entity.service)
| fieldsAdd avgRequests = arrayAvg(requests), totalErrors = arraySum(errors), totalRequests = arraySum(requests)
| fieldsAdd avgLatencyP90 = arrayAvg(latency_p90)
| fieldsAdd errorRate = if(totalRequests > 0, totalErrors / totalRequests * 100, else:0.0)
| fields Service, dt.entity.service, avgRequests, totalErrors, totalRequests, avgLatencyP90, errorRate`;
}

// ---------------------------------------------------------------------------
// Comparison Mode — Previous Period Timeseries
// ---------------------------------------------------------------------------
export function requestsTotalPrevQuery(topN: number, timeframeDays: number): string {
  return `timeseries requests = sum(dt.service.request.count),
           by:{dt.entity.service}, from:-${timeframeDays * 2}d, to:-${timeframeDays}d
| fieldsAdd service.name = entityName(dt.entity.service)
| fields timeframe, interval, service.name, dt.entity.service, requests
| sort arraySum(requests) desc
| limit ${topN}`;
}

export function latencyP90PrevQuery(topN: number, timeframeDays: number): string {
  return `timeseries latency_p90 = percentile(dt.service.request.response_time, 90),
           by:{dt.entity.service}, from:-${timeframeDays * 2}d, to:-${timeframeDays}d
| fieldsAdd service.name = entityName(dt.entity.service)
| fields timeframe, interval, service.name, dt.entity.service, latency_p90
| sort arrayAvg(latency_p90) desc
| limit ${topN}`;
}

export function failureRatePrevQuery(topN: number, timeframeDays: number): string {
  return `timeseries total = sum(dt.service.request.count, default:0),
           nonempty:true,
           by:{dt.entity.service}, from:-${timeframeDays * 2}d, to:-${timeframeDays}d
| lookup [
  timeseries errors = sum(dt.service.request.failure_count, default:0),
           nonempty:true,
           by:{dt.entity.service}, from:-${timeframeDays * 2}d, to:-${timeframeDays}d
], sourceField:dt.entity.service, lookupField:dt.entity.service, prefix:"request."
| fieldsAdd failureRate = request.errors[] / total[] * 100
| fieldsAdd service.name = entityName(dt.entity.service)
| fields timeframe, interval, service.name, dt.entity.service, failureRate
| sort arrayAvg(failureRate) desc
| limit ${topN}`;
}

export function http5xxPrevQuery(topN: number, timeframeDays: number): string {
  return `timeseries errors = sum(dt.service.request.count, default:0),
           nonempty:true,
           by:{dt.entity.service}, from:-${timeframeDays * 2}d, to:-${timeframeDays}d,
           filter: http.response.status_code >= 500 and http.response.status_code <= 599
| fieldsAdd service.name = entityName(dt.entity.service)
| fields timeframe, interval, service.name, dt.entity.service, errors
| sort arraySum(errors) desc
| limit ${topN}`;
}
