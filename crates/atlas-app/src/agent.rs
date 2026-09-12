//! The bounded actions the Agent Bridge will actually perform.
//!
//! Every action is either a read of already-published facts or the registration
//! of an Intent. None of them writes source, runs user code, or changes an
//! analysis. A caller cannot add an action by naming one: `bridge::is_bounded`
//! is the only gate, and the match below is exhaustive over that set.
use atlas_engine::{bridge, store::Store};
use serde_json::{Value, json};

pub const DEFAULT_AUTHOR: &str = "agent";

/// Perform one bounded action. Returns the result body to store, or an error
/// string that becomes the request's terminal reason.
pub fn perform(store: &Store, request: &bridge::AgentRequest) -> Result<Value, String> {
    let payload: Value = match request.payload.as_deref() {
        None => json!({}),
        Some(text) => serde_json::from_str(text).map_err(|e| format!("payload_not_json:{e}"))?,
    };
    let entity = request.entity_id.as_deref();
    match request.kind.as_str() {
        "inspect" => {
            let entity = entity.ok_or("inspect_requires_entity")?;
            let context = store
                .context(&request.analysis_id, entity)
                .map_err(|e| format!("context_unavailable:{e}"))?;
            Ok(bridge::action_result(
                "inspect",
                json!({
                    "analysis_id": request.analysis_id,
                    "entity_id": entity,
                    "context": context,
                }),
            ))
        }
        "annotate" => {
            let entity = entity.ok_or("annotate_requires_entity")?;
            let kind = payload
                .get("kind")
                .and_then(|v| v.as_str())
                .unwrap_or("intent");
            let body = payload
                .get("body")
                .and_then(|v| v.as_str())
                .ok_or("annotate_requires_body")?;
            let author = payload
                .get("proposed_by")
                .and_then(|v| v.as_str())
                .unwrap_or(DEFAULT_AUTHOR);
            let selection = bridge::selection(&request.analysis_id, entity, "entity");
            let (annotation, created) = store
                .create_annotation(&selection, kind, body, author)
                .map_err(|e| format!("annotation_refused:{e}"))?;
            Ok(bridge::action_result(
                "annotate",
                json!({
                    "annotation": annotation,
                    "created": created,
                }),
            ))
        }
        // A patch proposal is stored as a placeholder and nothing else happens.
        // There is deliberately no code path here that writes it anywhere: the
        // apply/verify/revert chain is a separate work item, and pretending
        // otherwise would be the exact failure mode the work order names.
        "propose_patch" => {
            let entity = entity.ok_or("propose_patch_requires_entity")?;
            let body = payload
                .get("body")
                .and_then(|v| v.as_str())
                .ok_or("propose_patch_requires_body")?;
            let author = payload
                .get("proposed_by")
                .and_then(|v| v.as_str())
                .unwrap_or(DEFAULT_AUTHOR);
            let selection = bridge::selection(&request.analysis_id, entity, "entity");
            let (annotation, created) = store
                .create_annotation(&selection, "patch", body, author)
                .map_err(|e| format!("proposal_refused:{e}"))?;
            let mut result = bridge::action_result(
                "propose_patch",
                json!({
                    "annotation": annotation,
                    "created": created,
                }),
            );
            result["applied"] = json!(false);
            result["applied_note"] = json!(
                "提案已登记为占位对象（code_exists=false）。本切片没有应用、重解析、测试或撤销的代码路径；把这里当成已应用会是虚假陈述。"
            );
            Ok(result)
        }
        other => Err(format!("action_not_bounded:{other}")),
    }
}
