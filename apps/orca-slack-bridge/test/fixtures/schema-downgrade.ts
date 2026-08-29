import type { DatabaseSync } from 'node:sqlite';

import { GATE_V8_SCHEMA_OBJECTS } from '../../src/store/schema.js';

/**
 * `gate_metadata`를 v14 이전 shape으로 되돌린다.
 *
 * 옛 버전 파일을 만드는 테스트는 현재 스키마로 만든 뒤 새 표를 지우고 version을 내린다.
 * v14는 표가 아니라 컬럼을 붙였으므로 그 방법으로는 `source`가 남고, 다시 열 때 v14
 * migration이 같은 컬럼을 또 붙이려다 실패한다. 여기서만 표를 옛 모양으로 다시 만들고
 * 기존 행을 그대로 옮긴다.
 */
export function downgradeGateMetadataToV13(db: DatabaseSync): void {
  db.exec(`
    -- index는 표를 따라가므로 먼저 지운다. 남겨 두면 아래 CREATE INDEX가 같은 이름으로 부딪힌다.
    DROP INDEX gate_metadata_run_key;
    ALTER TABLE gate_metadata RENAME TO gate_metadata_pre_v13_downgrade;
    ${GATE_V8_SCHEMA_OBJECTS['gate_metadata']};
    INSERT INTO gate_metadata
      (gate_key, run_key, task_key, dispatch_key, ask_message_id, question_thread_id,
       options_json, recommendation_option_id, recommendation_reason, impact, registered_at)
    SELECT gate_key, run_key, task_key, dispatch_key, ask_message_id, question_thread_id,
           options_json, recommendation_option_id, recommendation_reason, impact, registered_at
      FROM gate_metadata_pre_v13_downgrade;
    DROP TABLE gate_metadata_pre_v13_downgrade;
    ${GATE_V8_SCHEMA_OBJECTS['gate_metadata_run_key']};
  `);
}

/**
 * v15가 붙인 표를 지운다.
 *
 * 옛 버전 파일을 만드는 테스트는 현재 스키마로 만든 뒤 새 표를 지우고 version을 내린다. 새
 * 버전마다 이 목록이 늘어난다.
 */
export function dropTerminalPromptTables(db: DatabaseSync): void {
  db.exec(`
    DROP TABLE terminal_prompt_attempt;
    DROP TABLE terminal_prompt;
  `);
}
