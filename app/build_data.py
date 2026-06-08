"""Build app/data.json for the hallucination-span viewer.

Joins, for the English subset, the gold annotations (T2), and for every probe
model: the single-pass + self-consistency signals (T3/T4), the per-record Pearson
r against gold (T5), and the 10 generations (T4). Run once:

    python app/build_data.py
------
"""

import csv
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
OUT = Path(__file__).resolve().parent / "data.json"

SIGNALS = ("surprisal", "entropy", "maxprob", "selfcons")

# Probe: display name -> (signal-file slug, generation-file slug, corr-csv model_id)
PROBES = {
    "Llama-3-8B":  ("meta-llama-3-8b-instruct", "llama3-8b",  "meta-llama/Meta-Llama-3-8B-Instruct"),
    "Gemma-2-9B":  ("gemma-2-9b-it",            "gemma2-9b",  "google/gemma-2-9b-it"),
    "Qwen2.5-7B":  ("qwen2.5-7b-instruct",      "qwen2.5-7b", "Qwen/Qwen2.5-7B-Instruct"),
    "Mistral-7B":  ("mistral-7b-instruct-v0.3", "mistral-7b", "mistralai/Mistral-7B-Instruct-v0.3"),
}


def load_jsonl(path):
    with open(path, encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]


def load_pearson():
    """Return {model_id: {signal_type: {id: r}}} from the T5 per-record CSV."""
    out = {}
    path = DATA / "correlations_per_record.csv"
    if not path.exists():
        return out
    with open(path, newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            reason = (row.get("excluded_reason") or "").strip()
            if reason:
                continue
            r = row.get("pearson_r", "")
            if r == "" or r is None:
                continue
            out.setdefault(row["probe_model_id"], {}).setdefault(
                row["signal_type"], {})[row["id"]] = round(float(r), 3)
    return out


def main():
    gold = {r["id"]: r for r in load_jsonl(DATA / "processed_val.jsonl")
            if r["lang"] == "EN"}
    pearson = load_pearson()

    # Token-focus masks (RQ2): per-character 0/1 for entity / rare subsets.
    ne_mask = {r["id"]: r["mask"] for r in load_jsonl(DATA / "masks" / "ne.jsonl")}
    rare_mask = {r["id"]: r["mask"] for r in load_jsonl(DATA / "masks" / "rare.jsonl")}

    # Load each probe's signal arrays and generations.
    probe_data = {}
    for name, (sig_slug, gen_slug, model_id) in PROBES.items():
        sigs = {}
        for sig in SIGNALS:
            rows = load_jsonl(DATA / "signals" / f"{sig}_{sig_slug}.jsonl")
            sigs[sig] = {r["id"]: r["score"] for r in rows}
        gens = {r["id"]: [g["text"] for g in r["generations"]]
                for r in load_jsonl(DATA / "processed" / "t4" / "generations"
                                    / f"val.en.{gen_slug}.jsonl")}
        probe_data[name] = {"model_id": model_id, "signals": sigs, "gens": gens}

    out = []
    for rid, rec in gold.items():
        probes_obj = {}
        for name, pd in probe_data.items():
            if rid not in pd["gens"]:
                continue
            sig_obj, r_obj = {}, {}
            for sig in SIGNALS:
                sig_obj[sig] = pd["signals"][sig].get(rid)
                r_obj[sig] = pearson.get(pd["model_id"], {}).get(sig, {}).get(rid)
            probes_obj[name] = {
                "signals": sig_obj,
                "r": r_obj,
                "generations": pd["gens"][rid],
            }
        if not probes_obj:
            continue
        out.append({
            "id": rid,
            "question": rec["model_input"],
            "text": rec["model_output_text"],
            "gold": rec["gold"],
            "masks": {
                "ne": ne_mask.get(rid),
                "rare": rare_mask.get(rid),
            },
            "probes": probes_obj,
        })

    out.sort(key=lambda r: int(r["id"].split("-")[-1]))
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False)
    print(f"wrote {len(out)} EN records ({len(PROBES)} probes each) to {OUT}")


if __name__ == "__main__":
    main()
