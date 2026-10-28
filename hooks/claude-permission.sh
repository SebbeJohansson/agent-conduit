#!/bin/sh
# agent-conduit's Claude Code hook: leaves a marker while a session is waiting
# for you to allow or deny a tool, so an app reading the session can say so.
#
# Claude Code's transcript cannot tell "a tool is running" from "a tool is
# waiting for permission": both end on the same tool_use entry. This hook fills
# that gap with one small file per session,
#
#   ~/.claude/agent-conduit/permissions/<session id>.json
#   {"at":<epoch ms>,"tool":"Bash","toolUseId":"toolu_..."}
#
# written on PermissionRequest (and a permission_prompt Notification, for
# hosts that only send that), and removed once the session moves on: the tool
# finishing (PostToolUse/PostToolUseFailure, for the same tool call when the
# id is known), a new prompt, the turn or a subagent stopping, or the session
# ending. agent-conduit's readLiveClaudeSessions reads it.
#
# Installed by `npx agent-conduit install-claude-hook`. Plain sh, grep and sed, no
# runtime to start, because it runs on every tool call.

input=$(cat)

# The first occurrence: Claude Code writes its own fields before tool_input and
# tool_response, which can contain the same names.
field() {
  printf '%s' "$input" | grep -o "\"$1\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" | head -n 1 | sed 's/.*"\([^"]*\)"$/\1/'
}

session=$(field session_id)
case "$session" in
  ''|*/*|.*) exit 0 ;;
esac

dir="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/agent-conduit/permissions"
marker="$dir/$session.json"

case "$(field hook_event_name)" in
  PermissionRequest)
    mkdir -p "$dir"
    printf '{"at":%s,"tool":"%s","toolUseId":"%s"}\n' \
      "$(date +%s%3N)" "$(field tool_name)" "$(field tool_use_id)" > "$marker.tmp" \
      && mv "$marker.tmp" "$marker"
    ;;
  Notification)
    # Only adds a marker; a PermissionRequest one, which names the tool, wins.
    if [ "$(field notification_type)" = permission_prompt ] && [ ! -f "$marker" ]; then
      mkdir -p "$dir"
      printf '{"at":%s}\n' "$(date +%s%3N)" > "$marker.tmp" && mv "$marker.tmp" "$marker"
    fi
    ;;
  PostToolUse|PostToolUseFailure)
    [ -f "$marker" ] || exit 0
    # Another tool of the same batch finishing does not answer this prompt.
    waiting=$(sed -n 's/.*"toolUseId":"\([^"]*\)".*/\1/p' "$marker")
    finished=$(field tool_use_id)
    if [ -z "$waiting" ] || [ -z "$finished" ] || [ "$waiting" = "$finished" ]; then
      rm -f "$marker"
    fi
    ;;
  UserPromptSubmit|Stop|SubagentStop|SessionEnd)
    rm -f "$marker"
    ;;
esac

exit 0
