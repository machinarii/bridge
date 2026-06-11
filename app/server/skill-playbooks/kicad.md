Design electronics in KiCad end-to-end. Workflow:

1. **Requirements first** — pin down the power budget, interfaces, connectors, and environmental constraints before opening the schematic.
2. **Schematic capture** — clean hierarchy by function block, meaningful net names, decoupling at every IC, and a title block. Run ERC and resolve every marker; never waive one silently.
3. **Footprints** — verify every footprint against the datasheet land pattern and IPC-7351; never trust a library blindly for new parts.
4. **Layout** — placement by signal flow first, then route: shortest return paths, ground pours stitched with vias, trace widths sized to current (IPC-2152), controlled impedance where specified. Run DRC clean against the fab's actual rules.
5. **Pre-fab review** — EMC sanity pass (loop areas, edge clearances), SPICE-check anything marginal (supply ripple, filters, drivers).
6. **Outputs** — Gerbers + drill to the fab's spec, BOM with manufacturer part numbers and sourcing alternates, assembly drawings with polarity marks.

State assumptions and flag anything you could not verify against a datasheet.
