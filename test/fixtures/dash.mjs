/**
 * Hand-written DASH manifests.
 *
 * PROTECTED_MPD carries a Widevine ContentProtection element plus the common
 * `mp4protection` descriptor with a cenc:default_KID, which is what a real
 * DRM-protected stream looks like. CLEAN_MPD is the same manifest with those
 * elements removed and nothing else changed, so any difference in behaviour is
 * attributable to the ContentProtection alone.
 */

export const CLEAN_MPD = `<?xml version="1.0" encoding="utf-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static"
     mediaPresentationDuration="PT10M30S" minBufferTime="PT2S"
     profiles="urn:mpeg:dash:profile:isoff-live:2011">
  <Period id="1" start="PT0S">
    <AdaptationSet contentType="video" mimeType="video/mp4" segmentAlignment="true">
      <Representation id="video-1080" bandwidth="4500000" width="1920" height="1080" codecs="avc1.640028"/>
      <Representation id="video-720" bandwidth="2200000" width="1280" height="720" codecs="avc1.4d401f"/>
      <Representation id="video-360" bandwidth="700000" width="640" height="360" codecs="avc1.4d401e"/>
    </AdaptationSet>
    <AdaptationSet contentType="audio" mimeType="audio/mp4" lang="en">
      <Representation id="audio-128" bandwidth="128000" codecs="mp4a.40.2"/>
    </AdaptationSet>
  </Period>
</MPD>`;

export const PROTECTED_MPD = `<?xml version="1.0" encoding="utf-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" xmlns:cenc="urn:mpeg:cenc:2013" type="static"
     mediaPresentationDuration="PT10M30S" minBufferTime="PT2S"
     profiles="urn:mpeg:dash:profile:isoff-live:2011">
  <Period id="1" start="PT0S">
    <AdaptationSet contentType="video" mimeType="video/mp4" segmentAlignment="true">
      <ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011" value="cenc"
                         cenc:default_KID="1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d"/>
      <ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed" value="Widevine">
        <cenc:pssh>AAAAW3Bzc2gAAAAA7e2LqXnWSs6jyCfc1R0h7QAAADsIARIQ</cenc:pssh>
      </ContentProtection>
      <Representation id="video-1080" bandwidth="4500000" width="1920" height="1080" codecs="avc1.640028"/>
      <Representation id="video-720" bandwidth="2200000" width="1280" height="720" codecs="avc1.4d401f"/>
      <Representation id="video-360" bandwidth="700000" width="640" height="360" codecs="avc1.4d401e"/>
    </AdaptationSet>
    <AdaptationSet contentType="audio" mimeType="audio/mp4" lang="en">
      <ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed" value="Widevine"/>
      <Representation id="audio-128" bandwidth="128000" codecs="mp4a.40.2"/>
    </AdaptationSet>
  </Period>
</MPD>`;

export const MANIFEST_URL = 'https://stream.example.com/vod/asset-42/manifest.mpd';
