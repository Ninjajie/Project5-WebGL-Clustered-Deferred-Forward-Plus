export default function(params) {
  return `
  #version 100
  precision highp float;

  uniform float u_nearClip;
  uniform vec2 u_clusterTileSize;
  uniform float u_clusterZStride;
  uniform mat4 u_viewMatrix;
  //changed: add inverse matrices
  uniform mat4 u_inverseViewMat;
  uniform mat4 u_inverseViewProjMat;

  uniform sampler2D u_clusterbuffer;

  uniform sampler2D u_lightbuffer;

  
  uniform sampler2D u_gbuffers[${params.numGBuffers}];
  
  varying vec2 v_uv;

//copy useful functions from forwardPlus.frag.glsl

//logarithmic function to determine z-direction slices
int clusterZIndex(float viewSpaceZ, float nearClipz){
    return int(floor(log(viewSpaceZ - nearClipz + 1.0) * 2.15));
}

  struct Light {
    vec3 position;
    float radius;
    vec3 color;
  };

  float ExtractFloat(sampler2D texture, int textureWidth, int textureHeight, int index, int component) {
    float u = float(index + 1) / float(textureWidth + 1);
    int pixel = component / 4;
    float v = float(pixel + 1) / float(textureHeight + 1);
    vec4 texel = texture2D(texture, vec2(u, v));
    int pixelComponent = component - pixel * 4;
    if (pixelComponent == 0) {
      return texel[0];
    } else if (pixelComponent == 1) {
      return texel[1];
    } else if (pixelComponent == 2) {
      return texel[2];
    } else if (pixelComponent == 3) {
      return texel[3];
    }
  }

  Light UnpackLight(int index) {
    Light light;
    float u = float(index + 1) / float(${params.numLights + 1});
    vec4 v1 = texture2D(u_lightbuffer, vec2(u, 0.3));
    vec4 v2 = texture2D(u_lightbuffer, vec2(u, 0.6));
    light.position = v1.xyz;

    // LOOK: This extracts the 4th float (radius) of the (index)th light in the buffer
    // Note that this is just an example implementation to extract one float.
    // There are more efficient ways if you need adjacent values
    light.radius = ExtractFloat(u_lightbuffer, ${params.numLights}, 2, index, 3);

    light.color = v2.rgb;
    return light;
  }

  // Cubic approximation of gaussian curve so we falloff to exactly 0 at the light radius
  float cubicGaussian(float h) {
    if (h < 1.0) {
      return 0.25 * pow(2.0 - h, 3.0) - pow(1.0 - h, 3.0);
    } else if (h < 2.0) {
      return 0.25 * pow(2.0 - h, 3.0);
    } else {
      return 0.0;
    }
  }



  void main() {
    // TODO: extract data from g buffers and do lighting
    // vec4 gb0 = texture2D(u_gbuffers[0], v_uv);
    // vec4 gb1 = texture2D(u_gbuffers[1], v_uv);
    // vec4 gb2 = texture2D(u_gbuffers[2], v_uv);
    // vec4 gb3 = texture2D(u_gbuffers[3], v_uv);

//after optimization, we only have 2 g-buffers
//read from these 2 g-vuffers, get albedo and normal
// g-buffer[0] : color.x   | color.y   | color.z   | viewSpaceDepth
// g-buffer[1] : normal.x  | normal.y  | 0.0       | NDC_Depth
    vec3 albedo = texture2D(u_gbuffers[0], v_uv).rgb;;
    vec2 enNor = texture2D(u_gbuffers[1], v_uv).xy;

    float NDC_Depth = texture2D(u_gbuffers[1], v_uv).w;
    //v_position:
    vec4 screenSpacePos = vec4(v_uv * 2.0 - vec2(1.0), NDC_Depth, 1.0);
    vec4 tmp_pos = u_inverseViewProjMat * screenSpacePos;
    tmp_pos =  tmp_pos/tmp_pos.w;
    vec3 v_position = tmp_pos.xyz;

    //normal
    //reconstructing normal is easy to be wrong
    //it should be in view space to handle normals of fragments
    //but here need to transform normal back to world space
    vec3 normal;
    normal.xy = enNor;
    normal.z = sqrt(1.0 - dot(normal.xy, normal.xy));
    normal = vec3(u_inverseViewMat * vec4(normal, 0.0));

    vec3 fragColor = vec3(0.0);

    //kinda similar to forwardPlus shading
    //but instead of reading view space positon, just read depth
    
    //vec3 viewSpacePos3 = vec3(u_viewMatrix * vec4(v_position, 1.0));
    
    float viewSpaceDepth = texture2D(u_gbuffers[0], v_uv).w;

    //which cluster is this fragment in??
    int clusterXIdx = int(gl_FragCoord.x / u_clusterTileSize.x);
    int clusterYIdx = int(gl_FragCoord.y / u_clusterTileSize.y);
    //int clusterZIdx = int((-viewSpaceDepth - u_nearClip) / u_clusterZStride);
    int clusterZIdx = clusterZIndex(-viewSpaceDepth , u_nearClip);

    //cluster texture dimensions
    const int clusterTextureWidth = int(${params.numXSlices}) * int(${params.numYSlices}) * int(${params.numZSlices});
    const int clusterTextureHeight = int(ceil((float(${params.maxNumberLightsPerCluster}) + 1.0) / 4.0));

    //get light influence counts from cluster texture buffer:
    //get cluster index
    int clusterIdx = clusterXIdx + clusterYIdx * int(${params.numXSlices}) + clusterZIdx * int(${params.numXSlices}) * int(${params.numYSlices});
    
    //uv coords in cluster texture
    float clusterTex_u = float(clusterIdx + 1) / float(clusterTextureWidth + 1);
    float clusterTex_v = 0.0;
    float clusterTex_v_offset = 1.0 / float(clusterTextureHeight + 1);
    clusterTex_v += clusterTex_v_offset;

    //get the texel using the uv
    vec4 cluster_Tex = texture2D(u_clusterbuffer, vec2(clusterTex_u, clusterTex_v));
    //read influencing data from cluster texel
    int influencingLightCount = int(cluster_Tex[0]);
    //maximum number of light sources in cluster
    const int numLightsMax = int(min(float(${params.maxNumberLightsPerCluster}), float(${params.numLights})));

    //shade lights
    int clusterTexIdxToFetch = 1;
    for(int i = 0; i < numLightsMax; i++)
    {
      if(i == influencingLightCount)
      {
        break;
      }
      int lightIdx;
      if(clusterTexIdxToFetch == 0){
        lightIdx = int(cluster_Tex[0]);
      }
      if(clusterTexIdxToFetch == 1){
        lightIdx = int(cluster_Tex[1]);
      }
      if(clusterTexIdxToFetch == 2){
        lightIdx = int(cluster_Tex[2]);
      }
      if(clusterTexIdxToFetch == 3){
        lightIdx = int(cluster_Tex[3]);
      }
      clusterTexIdxToFetch++;

      Light light = UnpackLight(lightIdx);

      float lightDistance = distance(light.position, v_position);
      vec3 L = (light.position - v_position) / lightDistance;

      float lightIntensity = cubicGaussian(2.0 * lightDistance / light.radius);
      
//comment out for toon shading    
      //float lambertTerm = max(dot(L, normal), 0.0);
//Toon shading test
      float rampUnitLength = 0.25;
      float rampUnitValue = 0.33;
      float rampCoord = max(dot(L,normal) , 0.0);
      int rampLevel = int(rampCoord / rampUnitLength);
      float lambertTerm = float(rampLevel) * rampUnitValue;

      fragColor += albedo * lambertTerm * light.color * vec3(lightIntensity);
      
      if(clusterTexIdxToFetch == 4){
        clusterTexIdxToFetch = 0;
        clusterTex_v += clusterTex_v_offset;
        cluster_Tex = texture2D(u_clusterbuffer, vec2(clusterTex_u, clusterTex_v));
      }
    
    }

    const vec3 ambientLight = vec3(0.025);
    fragColor += albedo * ambientLight;

    gl_FragColor = vec4(fragColor, 1.0);
  }
  `;
}