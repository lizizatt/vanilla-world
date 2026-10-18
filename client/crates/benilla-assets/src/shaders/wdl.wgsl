// WDL distant terrain: the coarse horizon hulls the reference draws past the detailed tiles,
// unlit, untextured, white vertex diffuse fogged with the scene's fog colour. The hull emitter
// `0x6bd780` sets its own fog pair, start 0 and end 1.0 (`0x6bd7ae`-`0x6bd7c8`), so beyond one
// yard the hull is the flat fog colour: a silhouette against the unfogged sky.
//
// The band is a backdrop, not the far half of a shared clip plane. The reference's far-band pass
// (`0x6841a0`, projection at `0x6842f2`) uses near `farclip - 33` (`[0x8101b0]`) and the depth
// range `[0.955, 0.96]` (`[0x80febc]` = 0.96, `[0x80fec4]` = 0.005): the band overlaps the detailed
// world by 33 yd, closing the seam, and stays behind all of it. On Bevy's infinite reverse-Z
// (depth = near / eye_z) that range becomes a clamp just below `near / farclip`, the farthest
// depth the detailed world keeps (it discards past the wall), still in front of the sky's 0.0.

#import bevy_pbr::{
    mesh_functions,
    forward_io::Vertex,
    view_transformations::{position_world_to_clip, view_z_to_depth_ndc},
    mesh_view_bindings::view,
}

/// How far the band reaches inside the far-clip wall: the reference's far-band near plane
/// `farclip - 33.0` (`[0x8101b0]`, about one WDL outer cell).
const WDL_OVERLAP: f32 = 33.0;

/// Keeps the band strictly behind a world fragment exactly at the wall (`GreaterEqual` passes a
/// tie); multiplicative, so it never crosses zero into the sky.
const WDL_DEPTH_PUSH: f32 = 0.999;

// The shared global light (`lighting::global_light`), mirrored up to the rows WDL reads. Rows 4
// and 5 are the scene fog block, right by construction: the horizon band is never inside a WMO.
struct WowLight {
    _light_ambient: vec4<f32>, // 0
    _light_diffuse: vec4<f32>, // 1
    _light_sun: vec4<f32>,     // 2
    _light_spec: vec4<f32>,    // 3
    fog_color: vec4<f32>,      // 4 rgb = Light.dbc row 7 (gamma 0..1); w = enable (>0.5 ⇒ blend)
    fog_params: vec4<f32>,     // 5 xy = scene fog start/end (unread); w = farclip wall (0 = off)
};
@group(#{MATERIAL_BIND_GROUP}) @binding(90) var<storage, read> w: WowLight;
// Custom-fork opt-in only: zero keeps the reference fog hull unchanged.
@group(#{MATERIAL_BIND_GROUP}) @binding(91) var<uniform> racer_horizon: vec4<f32>;
// Racer only: the covering ADT tile's own minimap art, one 256² tile per mesh tile (`wdl.rs`
// binds a per-tile material). Unread by the stock branch; an unauthored/unloaded tile falls back
// to Bevy's opaque-white fallback image, a no-op multiply.
@group(#{MATERIAL_BIND_GROUP}) @binding(92) var ground_tile: texture_2d<f32>;
@group(#{MATERIAL_BIND_GROUP}) @binding(93) var ground_tile_sampler: sampler;
// Racer only: flags this mesh tile as a merged ADT liquid surface instead of terrain. `x` > 0.5
// activates it; `y` is the liquid kind (0 Still, 1 Ocean, 2 Magma — the only kinds an ADT MCLQ
// carries). Zero on every terrain tile and the whole stock hull.
@group(#{MATERIAL_BIND_GROUP}) @binding(94) var<uniform> racer_water: vec4<f32>;
// Racer only: flags this mesh as a vegetation/building LOD proxy instead of terrain or water.
// `x` > 0.5 activates it; `y` is the kind (0 vegetation, 1 building). Zero on every terrain/water
// tile and the whole stock hull.
@group(#{MATERIAL_BIND_GROUP}) @binding(95) var<uniform> racer_feature: vec4<f32>;

struct WdlVsOut {
    @builtin(position) clip_position: vec4<f32>,
    @location(0) world_position: vec4<f32>,
    // `0..1` across one mesh tile's own footprint (`benilla_formats::wdl::WdlTileMesh::uvs`); the
    // stock path never reads it.
    @location(1) uv: vec2<f32>,
}

struct WdlFsOut {
    @location(0) color: vec4<f32>,
    @builtin(frag_depth) depth: f32,
}

@vertex
fn vertex(in: Vertex) -> WdlVsOut {
    var out: WdlVsOut;
    let world_from_local = mesh_functions::get_world_from_local(in.instance_index);
    out.world_position =
        mesh_functions::mesh_position_local_to_world(world_from_local, vec4<f32>(in.position, 1.0));
    out.clip_position = position_world_to_clip(out.world_position.xyz);
    out.uv = in.uv;
    return out;
}

@fragment
fn fragment(in: WdlVsOut) -> WdlFsOut {
    // Planar eye-z, not radial: the band's near plane is a projection plane.
    let eye_z = -(view.view_from_world * vec4<f32>(in.world_position.xyz, 1.0)).z;
    let farclip = w.fog_params.w;
    let normal = normalize(cross(dpdx(in.world_position.xyz), dpdy(in.world_position.xyz)));

    // The near plane is `farclip - 33`, not the wall: the overlap closes the coarse-vs-fine seam.
    // Racer geometry shares real scene depth; only the stock fog hull uses the overlap clamp.
    let near_band = select(farclip - WDL_OVERLAP, farclip, racer_horizon.z > 0.0);
    if (farclip > 0.0 && eye_z < near_band) {
        discard;
    }

    // White vertex diffuse under the hull's own fog pair, saturated beyond one yard: the flat fog
    // colour, never the scene fog distances. With fog off the reference shows the bare white hull.
    var rgb = vec3<f32>(1.0);
    if (w.fog_color.w > 0.5) {
        rgb = w.fog_color.xyz;
    }

    if (racer_horizon.z > 0.0) {
        let distance = length(in.world_position.xz - view.world_position.xz);
        if (distance >= racer_horizon.z) {
            discard;
        }
        // Screen-door fade removes the finite residency edge without enabling transparent depth.
        let fade = smoothstep(racer_horizon.y, racer_horizon.z, distance);
        let pixel = floor(in.clip_position.xy);
        let threshold = fract(sin(dot(pixel, vec2<f32>(12.9898, 78.233))) * 43758.5453);
        if (threshold < fade) {
            discard;
        }
        let shade = 0.55 + 0.45 * abs(dot(normal, normalize(vec3<f32>(0.4, 0.8, 0.3))));
        var surface: vec3<f32>;
        if (racer_water.x > 0.5) {
            // A merged ADT liquid tile: flat per-kind colour, no ground sampling. Still/Ocean a
            // translucent-reading blue-teal (ocean a touch deeper), Magma an unlit-reading orange;
            // real ADT MCLQ never carries Slime (`benilla_formats::liquid`'s ADT nibble map has no
            // class-3 queue), so no fourth colour is needed here.
            var water_color = vec3<f32>(0.10, 0.35, 0.52); // Still (lake, river)
            if (racer_water.y > 1.5) {
                water_color = vec3<f32>(0.80, 0.26, 0.04); // Magma
            } else if (racer_water.y > 0.5) {
                water_color = vec3<f32>(0.05, 0.22, 0.42); // Ocean
            }
            surface = rgb * shade * water_color;
        } else if (racer_feature.x > 0.5) {
            // The bounded atlas stores the authored leaf-card alpha, not opaque rectangles.
            if (textureSample(ground_tile, ground_tile_sampler, in.uv).a < 224.0 / 255.0) {
                discard;
            }
            var feature_color = vec3<f32>(0.12, 0.42, 0.16); // Vegetation: a muted canopy green
            if (racer_feature.y > 0.5) {
                feature_color = vec3<f32>(0.55, 0.53, 0.50); // Building: a flat stone grey
            }
            surface = rgb * shade * feature_color;
        } else {
            // The per-tile minimap art replaces the flat procedural tint; `shade` and the hull's
            // own `rgb` (white, or the scene fog colour) stay as multipliers on top of it.
            let ground_tex = textureSample(ground_tile, ground_tile_sampler, in.uv).rgb;
            surface = rgb * shade * ground_tex;
        }
        // Remain a fog hull at the detailed overlap; show coarse relief farther out, then fog
        // completely before the outer fade. This is visual terrain, not collision or ADT detail.
        let reveal = smoothstep(max(farclip, 0.0), max(farclip, 0.0) + 200.0, eye_z);
        let fog = smoothstep(racer_horizon.x, racer_horizon.y, distance);
        rgb = mix(rgb, surface, reveal * (1.0 - fog));
    }

    var out: WdlFsOut;
    // Raw gamma out; the frame decodes once, in the FFXGlow combine.
    out.color = vec4<f32>(rgb, 1.0);
    // The depth clamp. `view_z_to_depth_ndc` takes view-space z, negative in front of the camera,
    // so the wall is at `-farclip`.
    var depth = in.clip_position.z;
    if (farclip > 0.0 && racer_horizon.z == 0.0) {
        depth = min(depth, view_z_to_depth_ndc(-farclip) * WDL_DEPTH_PUSH);
    }
    out.depth = depth;
    return out;
}
