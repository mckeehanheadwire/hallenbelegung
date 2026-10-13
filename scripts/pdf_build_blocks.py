# Step 2 of the PDF import: cells.json -> belegung_halbstunden.csv + belegung_bloecke.csv.
# Usage: python scripts/pdf_build_blocks.py <output-dir>   (then: python wren_import.py)
import json, csv, collections, sys
out=sys.argv[1]
d=json.load(open("cells.json",encoding="utf-8"))
DAYS=["Montag","Dienstag","Mittwoch","Donnerstag","Freitag","Samstag","Sonntag"]
rows=d["rows"]
for r in rows:
    if r["Saison"].startswith("April-Sept.O"): r["Saison"]="April-Sept."
    if "Füllerich" in r["Halle"] and r["Tag"]=="Dienstag" and r["Saison"]=="": r["Saison"]="Okt.-März"
    r["Von"],r["Bis"]=r["Zeit"].split("-")
    if "Aebnit" in r["Halle"] and r["Zeit"] in ("13.00-13.30","13.30-14.00") and r["Kategorie"]=="Schule": r["Notiz"]="Tagesschule"
    if r["Kategorie"]=="frei" and r["Notiz"]: r["Kategorie"]=r["Notiz"]; r["Notiz"]=""  # e.g. Reinigung
    if r["Zeit"]=="07.00-07.30" and r["Saison"]: r["Kategorie"]="frei"  # season-label header cell
# collapse season sub-columns where both seasons identical
grp=collections.defaultdict(list)
for r in rows: grp[(r["Halle"],r["Tag"],r["Zeit"])].append(r)
cells=[]
for k,v in grp.items():
    if len(v)>1 and len({x["Kategorie"] for x in v})==1:
        v=[dict(v[0],Saison="ganzjährig",Notiz=" ".join(filter(None,{x["Notiz"] for x in v})))]
    elif len(v)==1: v=[dict(v[0],Saison="ganzjährig")]
    cells.extend(v)
halls=list(dict.fromkeys(r["Halle"] for r in rows))
key=lambda r:(halls.index(r["Halle"]),DAYS.index(r["Tag"]),r["Zeit"],r["Saison"])
cells.sort(key=key)
F=["Halle","Tag","Saison","Von","Bis","Kategorie","Notiz"]
with open(f"{out}/belegung_halbstunden.csv","w",newline="",encoding="utf-8-sig") as f:
    w=csv.DictWriter(f,F,extrasaction="ignore",delimiter=";"); w.writeheader(); w.writerows(cells)
# merge into blocks per hall/day/season (season-split slots also count for that season)
blocks=[]
for h in halls:
  for day in DAYS:
    cs=[c for c in cells if c["Halle"]==h and c["Tag"]==day]
    seasons=sorted({c["Saison"] for c in cs}-{"ganzjährig"})
    views=seasons or ["ganzjährig"]
    for s in views:
        seq=sorted([c for c in cs if c["Saison"] in (s,"ganzjährig")],key=lambda c:c["Zeit"])
        cur=None
        for c in seq:
            if cur and cur["Kategorie"]==c["Kategorie"] and cur["Bis"]==c["Von"] and cur["Notiz"]==c["Notiz"]:
                cur["Bis"]=c["Bis"]
            else:
                if cur: blocks.append(cur)
                cur=dict(Halle=h,Tag=day,Saison=s,Von=c["Von"],Bis=c["Bis"],Kategorie=c["Kategorie"],Notiz=c["Notiz"])
        if cur: blocks.append(cur)
blocks=[b for b in blocks if b["Kategorie"]!="frei"]
with open(f"{out}/belegung_bloecke.csv","w",newline="",encoding="utf-8-sig") as f:
    w=csv.DictWriter(f,F,delimiter=";"); w.writeheader(); w.writerows(blocks)
# occupancy stats (use first season view per day for split days)
print("Halle | belegt | frei | n.v. | Auslastung | Schule | Priv.Schule | Verein | Priv.Gruppe")
for h in halls:
    cnt=collections.Counter()
    for day in DAYS:
        cs=[c for c in cells if c["Halle"]==h and c["Tag"]==day]
        seasons=sorted({c["Saison"] for c in cs}-{"ganzjährig"})
        s=seasons[0] if seasons else "ganzjährig"
        for c in cs:
            if c["Saison"] in (s,"ganzjährig"): cnt[c["Kategorie"]]+=1
    nv=cnt["nicht verfügbar"]; free=cnt["frei"]; tot=sum(cnt.values())
    booked=tot-nv-free
    print(h,"|",booked/2,"h |",free/2,"h |",nv/2,"h |",f"{booked/(tot-nv):.0%}","|",cnt["Schule"]/2,"|",cnt["Private Schule"]/2+cnt["Schule extern"]/2,"|",cnt["Verein/Stiftung"]/2,"|",cnt["Private Gruppe"]/2)
