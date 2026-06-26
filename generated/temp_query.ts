/**
/* Automatically generated code for temp_query.dql
*/
import { queryExecutionClient, QueryStartResponse } from '@dynatrace-sdk/client-query';

export function getQueryString(){
  return `fetch dt.entity.service
| fieldsAdd pgs = runs_on[dt.entity.process_group]
| expand pg = pgs
| lookup [fetch dt.entity.process_group | fieldsAdd caId = belongs_to[dt.entity.cloud_application] | fields id, caId], sourceField:pg, lookupField:id, prefix:"pg."
| filter isNotNull(pg.caId)
| expand caId = pg.caId
| lookup [fetch dt.entity.cloud_application | fields id, entity.name], sourceField:caId, lookupField:id, prefix:"ca."
| filter isNotNull(ca.entity.name)
| fields serviceName = entity.name, workloadName = ca.entity.name, workloadId = ca.id
| dedup serviceName, workloadName
| limit 20`;
}

export async function runQuery(): Promise<QueryStartResponse> {
  return await queryExecutionClient.queryExecute({body: { query: getQueryString(), requestTimeoutMilliseconds: 30000 }});
}