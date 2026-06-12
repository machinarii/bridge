#!/usr/bin/env bash
#
# QA helper — create a fully-formed project from prefilled text, skipping the
# capture UI (roles → topology → name → objective → features). Hits the running
# Bridge server and triggers the PM kickoff, so you land straight in the flow.
#
#   bash scripts/qa-new-project.sh [preset]
#   npm run qa:new -- [preset]
#
# Presets: trading (default) | recipes | iot
# Override any field via env, e.g.:
#   QA_NAME="My App" QA_GOAL="..." QA_FEATURES="..." bash scripts/qa-new-project.sh
#   QA_ROLES='["pm","sw_engineer","qa"]' QA_TOPOLOGY=feature-teams bash scripts/qa-new-project.sh recipes
#
# Requirements: server up on :4317 (npm run server) and OPENROUTER_API_KEY set
# (in app/server/.env) for the PM to draft a kickoff plan.
set -euo pipefail

BASE="${BRIDGE_URL:-http://localhost:4317}"
PRESET="${1:-trading}"

case "$PRESET" in
  trading)
    NAME="Day Trading Mobile App"
    GOAL="A beginner-friendly mobile app for day trading stocks: voice-driven order entry, bite-sized market tips, and an AI sell-time signal — runnable offline for demos."
    FEATURES="Voice order entry; tiered order confirmation (small auto, large re-confirm); mock brokerage adapter; AI sell-time prediction with a clear 'not financial advice' disclaimer; biometric re-auth on order submit; a curated 'what to buy' discovery feed."
    ROLES='["pm","sw_engineer","designer","qa","security","legal","marketing"]'
    TOPOLOGY="hub-and-spoke"
    ;;
  recipes)
    NAME="Weeknight Recipe Planner"
    GOAL="A web app that plans a week of dinners from what is already in your fridge, builds a shopping list, and scales recipes to household size."
    FEATURES="Pantry-aware meal suggestions; auto shopping list; serving-size scaling; dietary filters (veg, gluten-free); one-tap 'cook tonight' with step timers."
    ROLES='["pm","sw_engineer","designer","qa","data_sci"]'
    TOPOLOGY="feature-teams"
    ;;
  iot)
    NAME="Smart Home Energy Dashboard"
    GOAL="A dashboard that shows real-time home energy use per device and suggests concrete ways to save."
    FEATURES="Per-device live usage; monthly cost projection; anomaly alerts; ranked savings suggestions; a weekly email/PDF report."
    ROLES='["pm","sw_engineer","hw_engineer","ee_engineer","designer","data_sci","security"]'
    TOPOLOGY="hub-and-spoke"
    ;;
  *)
    echo "unknown preset '$PRESET' — try: trading | recipes | iot" >&2
    exit 1
    ;;
esac

# Env overrides win over the preset.
NAME="${QA_NAME:-$NAME}"
GOAL="${QA_GOAL:-$GOAL}"
FEATURES="${QA_FEATURES:-$FEATURES}"
ROLES="${QA_ROLES:-$ROLES}"
TOPOLOGY="${QA_TOPOLOGY:-$TOPOLOGY}"

# Quick reachability check.
if ! curl -fsS -m 3 "$BASE/" >/dev/null 2>&1; then
  echo "✗ Bridge server not reachable at $BASE — start it with: npm run server" >&2
  exit 1
fi

# Build the JSON body with node so quotes/special chars in goal/features are
# escaped safely (no fragile shell quoting).
PAYLOAD="$(NAME="$NAME" GOAL="$GOAL" FEATURES="$FEATURES" ROLES="$ROLES" TOPOLOGY="$TOPOLOGY" node -e '
  process.stdout.write(JSON.stringify({
    name: process.env.NAME,
    goal: process.env.GOAL,
    features: process.env.FEATURES,
    roleIds: JSON.parse(process.env.ROLES),
    topology: process.env.TOPOLOGY,
  }));
')"

echo "→ creating preset '$PRESET' at $BASE/projects"
echo "  name:     $NAME"
echo "  roles:    $ROLES"
echo "  topology: $TOPOLOGY"

RES="$(curl -fsS -X POST "$BASE/projects" -H 'Content-Type: application/json' -d "$PAYLOAD")"

echo "$RES" | node -e '
  let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
    try {
      const p = JSON.parse(s);
      console.log("✓ created " + p.id);
      console.log("  lead:  " + p.leadAgentId + " (kickoff is drafting)");
      console.log("  open the app, select the project, and the PM plan bubble appears.");
    } catch { console.log("response: " + s); }
  });
'
