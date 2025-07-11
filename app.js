/* ––––– helpers ––––– */
const R = 6371000;
const toRad = d => d * Math.PI / 180;
const haversine = (la1, lo1, la2, lo2) => {
  const dLat = toRad(la2 - la1), dLon = toRad(lo2 - lo1);
  const a = Math.sin(dLat/2)**2 +
            Math.cos(toRad(la1))*Math.cos(toRad(la2))*Math.sin(dLon/2)**2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};
const colours = ['purple','blue','green','yellow','orange','red'];
const colourForSpeed = (v,min,max) =>
  colours[Math.min(colours.length-1,
    Math.floor(((v-min)/(max-min+1e-9))*colours.length))];

let lastMarkers = [];          // will hold {lat, lon, name} for the current run
let speedLegend = null;      // Leaflet control instance (one per track)
let elevationChart = null;

function downloadAsGPX(pts){
  const gpx =
`<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="GPX visualiser">
${pts.map(p=>`  <wpt lat="${p.lat}" lon="${p.lon}"><name>${p.name}</name></wpt>`).join('\n')}
</gpx>`;
  const blob = new Blob([gpx], {type:'application/gpx+xml'});
  const a = Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(blob),
    download: 'markers.gpx'
  });
  a.click(); URL.revokeObjectURL(a.href);
}

function updateLegend(min, max){
  if (speedLegend) map.removeControl(speedLegend);   // wipe previous one
  const steps = colours.length, step = (max-min||1)/steps;

  speedLegend = L.control({position:'bottomright'});
  speedLegend.onAdd = function(){
    const div = L.DomUtil.create('div','speed-legend');
    for(let i=0;i<steps;i++){
      const a = (min + i*step).toFixed(1),
            b = (min + (i+1)*step).toFixed(1);
      div.innerHTML += `<i style="background:${colours[i]}"></i>${a}–${b} m/s<br>`;
    }
    return div;
  };
  speedLegend.addTo(map);
}

function drawElevationChart(pts){
  const c=document.getElementById('elevChart'); if(!c) return;

  const labels=[0], data=[pts[0].ele||0];     // km , metres
  let cum=0;
  for(let i=1;i<pts.length;i++){
    cum+=haversine(pts[i-1].lat,pts[i-1].lon,pts[i].lat,pts[i].lon)/1000;
    labels.push(+cum.toFixed(1));
    data.push(pts[i].ele||data[data.length-1]);
  }

  if(elevationChart) elevationChart.destroy();
  elevationChart = new Chart(c.getContext('2d'),{
    type:'line',
    data:{labels,datasets:[{data,
      borderColor:'brown',pointRadius:0,fill:false,tension:0.1}]},
    options:{plugins:{legend:{display:false}},
             scales:{x:{title:{display:true,text:'Distance (km)'}},
                     y:{title:{display:true,text:'Elevation (m)'}}}}
  });
}

/* ––––– map ––––– */
const map = L.map('map').setView([0,0],2);
const drawn = L.featureGroup().addTo(map);   /* holds the track currently shown */
L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',{
  attribution:'© OpenStreetMap, SRTM | OpenTopoMap (CC-BY-SA)'
}).addTo(map);

/* ––––– UI ––––– */

/* render buckets by “days” -------------------------------------------- */
document.getElementById('daysBtn').addEventListener('click', () => {
  const file = document.getElementById('gpxFile').files[0];
  if (!file) { alert('Choose a GPX file'); return; }
  const v      = document.getElementById('daysCount').value.trim();
  const numberOfDays  = v ? parseFloat(v) : NaN;          // may still be NaN
  const reader = new FileReader();
  reader.onload = e => renderMap(e.target.result, 'days', numberOfDays);
  reader.readAsText(file);
});

document.getElementById('exportBtn')
        .addEventListener('click', () => downloadAsGPX(lastMarkers));

/* ––––– GPX → map ––––– */
function renderMap(gpxText, mode, numberOfDays){
  lastMarkers = [];
  document.getElementById('exportBtn').disabled = true;
  drawn.clearLayers();                    // wipe previous track & markers
  const pts = Array.from(new DOMParser()
    .parseFromString(gpxText,'application/xml')
    .getElementsByTagName('trkpt'))
    .map(p => ({
      lat:+p.getAttribute('lat'),
      lon:+p.getAttribute('lon'),
      ele:parseFloat(p.getElementsByTagName('ele')[0]?.textContent||'0'),
      time:new Date(p.getElementsByTagName('time')[0]?.textContent)
    }));
  if (pts.length<2){alert('Not enough points');return;}

  drawDays(pts, numberOfDays);    // show only the requested days
  drawElevationChart(pts);

  if (lastMarkers.length)
    document.getElementById('exportBtn').disabled = false;

  if (drawn.getLayers().length) {
    const bounds = drawn.getBounds();
    map.once('moveend', () => map.zoomIn());  // register first
    map.fitBounds(bounds);                    // then trigger the move
  }
}


function drawDays(pts, numberOfDays){
  const base = pts[0].time;                       // ride start-time (ms)

  /* ---------- time-slice definition (fractional first slice) ---------- */
  const totalDurationMs = pts[pts.length - 1].time - base;
  const validInput = Number.isFinite(numberOfDays) && numberOfDays > 0;

  const slice   = validInput ? totalDurationMs / numberOfDays : totalDurationMs; // length of every “full” slice
  const full    = validInput ? Math.floor(numberOfDays) : 0;                     // integer part
  const frac    = validInput ? numberOfDays - full : 0;                          // 0 ≤ frac < 1
  const firstMs = frac ? frac * slice : slice;                                   // shorter first slice if fractional
  let   nextT   = +base + firstMs;                                               // next threshold timestamp (ms)

  // Compute segment speeds and their limits
  const speeds = pts.slice(1).map((p,i)=>
    haversine(pts[i].lat, pts[i].lon, p.lat, p.lon) /
    (((p.time - pts[i].time) / 1000) || 1)         // m / s
  );
  const [min, max] = [Math.min(...speeds), Math.max(...speeds)];
  updateLegend(min, max);

  /* draw the coloured track + add a marker at the end of each slice
     whose popup shows the distance (km) covered inside that slice   */
  let bucketDist    = 0;                       // metres accumulated in it
  let bucketTime    = 0;                       // ms accumulated in it

  for (let i = 1; i < pts.length; i++) {
    const prev = pts[i - 1], curr = pts[i];

    const segDist = haversine(prev.lat, prev.lon, curr.lat, curr.lon);
    const segTime = curr.time - prev.time;
    bucketDist += segDist;
    bucketTime += segTime;

    /* emit one marker for every threshold we cross            */
    while (curr.time >= nextT) {
      const name = (bucketDist/1000).toFixed(1) + ' km, ' +
                   (bucketTime/3_600_000).toFixed(1) + ' h';
      L.marker([prev.lat, prev.lon]).addTo(drawn).bindPopup(name);
      lastMarkers.push({lat: prev.lat, lon: prev.lon, name});

      bucketDist = bucketTime = 0;
      nextT += slice;                       // after (possibly short) first slice, all are equal
    }

    L.polyline(
      [[prev.lat, prev.lon], [curr.lat, curr.lon]],
      { color: colourForSpeed(speeds[i - 1], min, max), weight: 4 }
    ).addTo(drawn);
  }

  /* drop the final slice’s marker */
  if (bucketDist) {
    const last = pts[pts.length - 1];
    const name = (bucketDist/1000).toFixed(1) + ' km, ' +
                 (bucketTime/3_600_000).toFixed(1) + ' h';
    L.marker([last.lat, last.lon]).addTo(drawn).bindPopup(name);
    lastMarkers.push({lat: last.lat, lon: last.lon, name});
  }
}
