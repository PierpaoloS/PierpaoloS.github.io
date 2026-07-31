# ============================================================
#  BUILD dell'app "Giappone Guida"
#  Assembla index.html da index.template.html:
#   - icone della guida (icons/norm/*.png) -> base64
#   - foto zone (app/img/src/*.jpg) -> ridimensionate + base64
#   - genera icon-192/512, manifest.webmanifest, sw.js
#  Uso:  powershell -ExecutionPolicy Bypass -File build.ps1
# ============================================================
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Drawing
$app   = Split-Path -Parent $MyInvocation.MyCommand.Path
$proj  = Split-Path -Parent $app
$tpl   = Get-Content (Join-Path $app 'index.template.html') -Raw -Encoding UTF8

# ---------- 1. icone guida ----------
$iconDir = Join-Path $proj 'icons\norm'
if(-not (Test-Path $iconDir)){ $iconDir = Join-Path $proj 'icons' }
foreach($f in Get-ChildItem "$iconDir\*.png"){
  $b64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($f.FullName))
  $tpl = $tpl.Replace('@@ICON_' + $f.BaseName + '@@', "data:image/png;base64,$b64")
}

# ---------- 2. foto zone (resize 720px, jpeg q72) ----------
function ResizeToB64($path,$maxW){
  $img=[System.Drawing.Bitmap]::FromFile($path)
  $w=[math]::Min($maxW,$img.Width); $h=[int]($img.Height*($w/$img.Width))
  $nb=New-Object System.Drawing.Bitmap $w,$h
  $g=[System.Drawing.Graphics]::FromImage($nb)
  $g.InterpolationMode='HighQualityBicubic'
  $g.DrawImage($img,0,0,$w,$h)
  $enc=[System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object {$_.MimeType -eq 'image/jpeg'}
  $ep=New-Object System.Drawing.Imaging.EncoderParameters 1
  $ep.Param[0]=New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality,72L)
  $ms=New-Object IO.MemoryStream
  $nb.Save($ms,$enc,$ep)
  $b64=[Convert]::ToBase64String($ms.ToArray())
  $ms.Dispose();$g.Dispose();$nb.Dispose();$img.Dispose()
  return $b64
}
$credits = Get-Content (Join-Path $app 'img\credits.json') -Raw | ConvertFrom-Json
$photos=@{}
foreach($f in Get-ChildItem (Join-Path $app 'img\src\*.jpg')){
  $id=$f.BaseName
  $b64=ResizeToB64 $f.FullName 720
  $cr='CC'; $li=''
  if($credits.PSObject.Properties.Name -contains $id){
    $cr=$credits.$id.creator; $li=$credits.$id.license
  }
  $photos[$id]=@{src="data:image/jpeg;base64,$b64"; credit="$cr · $li"}
}
# alias citta' -> foto di una zona rappresentativa
$alias=@{city_tokyo='shibuya'; city_kyoto='kfushimi'; city_osaka='onamba'; city_okinawa='kisole'}
foreach($k in $alias.Keys){ if($photos.ContainsKey($alias[$k])){ $photos[$k]=$photos[$alias[$k]] } }
# JSON manuale (ConvertTo-Json troncherebbe le stringhe lunghe in vecchie PS)
$sb=New-Object Text.StringBuilder
[void]$sb.Append('{')
$first=$true
foreach($k in $photos.Keys){
  if(-not $first){[void]$sb.Append(',')}; $first=$false
  $credJs = $photos[$k].credit -replace '\\','\\\\' -replace '"','\"'
  [void]$sb.Append('"'+$k+'":{"src":"'+$photos[$k].src+'","credit":"'+$credJs+'"}')
}
[void]$sb.Append('}')
$tpl=$tpl.Replace('@@PHOTOS@@',$sb.ToString())

# ---------- 3. scrivi index.html ----------
$outFile=Join-Path $app 'index.html'
[IO.File]::WriteAllText($outFile,$tpl,(New-Object Text.UTF8Encoding $false))
"index.html scritto: {0:N0} KB" -f ((Get-Item $outFile).Length/1KB)

# ---------- 4. icone PWA (torii bianco su disco terracotta) ----------
function AppIcon($size,$out){
  $bmp=New-Object System.Drawing.Bitmap $size,$size
  $g=[System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode='AntiAlias'
  $g.Clear([System.Drawing.Color]::FromArgb(255,194,105,62))  # C2693E
  $torii=Join-Path $iconDir 'torii.png'
  if(Test-Path $torii){
    $ic=[System.Drawing.Bitmap]::FromFile($torii)
    $m=[int]($size*0.18)
    $g.DrawImage($ic,$m,$m,$size-2*$m,$size-2*$m)
    $ic.Dispose()
  }
  $bmp.Save($out,[System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose();$bmp.Dispose()
}
AppIcon 192 (Join-Path $app 'icon-192.png')
AppIcon 512 (Join-Path $app 'icon-512.png')

# ---------- 5. manifest + service worker ----------
@'
{
  "name": "Giappone · Guida di viaggio",
  "short_name": "Giappone",
  "start_url": "./index.html",
  "display": "standalone",
  "background_color": "#FAF6EF",
  "theme_color": "#C2693E",
  "icons": [
    {"src":"icon-192.png","sizes":"192x192","type":"image/png"},
    {"src":"icon-512.png","sizes":"512x512","type":"image/png"}
  ]
}
'@ | Out-File -Encoding utf8 (Join-Path $app 'manifest.webmanifest')

@'
const C='giappone-v3';
self.addEventListener('install',e=>{
  self.skipWaiting();
  e.waitUntil(caches.open(C).then(c=>c.addAll(['./','./index.html','./manifest.webmanifest'])));
});
self.addEventListener('activate',e=>{
  e.waitUntil((async()=>{
    const keys=await caches.keys();
    await Promise.all(keys.filter(k=>k!==C).map(k=>caches.delete(k)));
    await self.clients.claim();
  })());
});
self.addEventListener('fetch',e=>{
  const req=e.request;
  if(req.method!=='GET') return;
  const url=new URL(req.url);
  if(url.origin!==location.origin) return;
  const isDoc = req.mode==='navigate' || url.pathname==='/' || url.pathname.endsWith('/index.html');
  if(isDoc){
    e.respondWith(
      fetch(req).then(r=>{const c=r.clone(); caches.open(C).then(x=>x.put('./index.html',c)); return r;})
        .catch(()=>caches.match('./index.html').then(r=>r||caches.match('./')))
    );
    return;
  }
  e.respondWith(
    caches.match(req).then(cached=>cached || fetch(req).then(r=>{const c=r.clone(); caches.open(C).then(x=>x.put(req,c)); return r;}))
  );
});
'@ | Out-File -Encoding utf8 (Join-Path $app 'sw.js')

"BUILD COMPLETATA."
