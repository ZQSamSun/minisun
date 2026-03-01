// Server-side JSON/YouTube channel tools
// Exact names for grading: generateImage, plot_metric_vs_time, play_video, compute_stats_json

const { generateImage } = require('./imageService');

// generateImage alone — for use when no YouTube JSON is loaded
const IMAGE_TOOL_DECLARATIONS = [
  {
    name: 'generateImage',
    description:
      'Generate an image from a text prompt using Imagen (or Gemini as fallback). ' +
      'Use whenever the user asks to create, generate, draw, or visualize an image. No YouTube JSON required.',
    parameters: {
      type: 'OBJECT',
      properties: {
        prompt: { type: 'STRING', description: 'Text description of the image to generate.' },
        anchorImageBase64: {
          type: 'STRING',
          description: 'Optional. Base64-encoded reference image to guide generation.',
        },
        anchorMimeType: {
          type: 'STRING',
          description: 'MIME type of anchor image if provided (default image/png).',
        },
      },
      required: ['prompt'],
    },
  },
];

const JSON_TOOL_DECLARATIONS = [
  {
    name: 'generateImage',
    description:
      'Generate an image from a text prompt using Imagen (or Gemini as fallback). ' +
      'Optionally provide an anchor/reference image for style or content. Returns the generated image for display with download and enlarge options.',
    parameters: {
      type: 'OBJECT',
      properties: {
        prompt: { type: 'STRING', description: 'Text description of the image to generate.' },
        anchorImageBase64: {
          type: 'STRING',
          description: 'Optional. Base64-encoded reference image to guide generation (e.g. for style transfer).',
        },
        anchorMimeType: {
          type: 'STRING',
          description: 'MIME type of anchor image if provided (default image/png).',
        },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'plot_metric_vs_time',
    description:
      'Plot a numeric field (e.g. viewCount, likeCount) vs time (publishedAt) from YouTube channel JSON. ' +
      'Returns chart data for a React component with enlarge and download options.',
    parameters: {
      type: 'OBJECT',
      properties: {
        metricField: {
          type: 'STRING',
          description:
            'Numeric field to plot on Y-axis. Common: viewCount, likeCount, commentCount, duration.',
        },
        timeField: {
          type: 'STRING',
          description: 'Time/date field for X-axis (default: publishedAt).',
        },
      },
      required: ['metricField'],
    },
  },
  {
    name: 'play_video',
    description:
      'Show a video card (title + thumbnail). Clicking opens the video in a new tab. Use when user asks to watch or play a specific video.',
    parameters: {
      type: 'OBJECT',
      properties: {
        videoId: { type: 'STRING', description: 'YouTube video ID.' },
        title: { type: 'STRING', description: 'Video title for the card.' },
        thumbnailUrl: {
          type: 'STRING',
          description: 'Thumbnail URL for the card.',
        },
      },
      required: ['videoId', 'title'],
    },
  },
  {
    name: 'compute_stats_json',
    description:
      'Compute mean, median, std, min, max for a numeric field in the channel JSON (e.g. viewCount, likeCount).',
    parameters: {
      type: 'OBJECT',
      properties: {
        field: {
          type: 'STRING',
          description: 'Exact field name. Common: viewCount, likeCount, commentCount, duration.',
        },
      },
      required: ['field'],
    },
  },
];

function resolveField(videos, name) {
  if (!videos?.length) return name;
  const keys = Object.keys(videos[0]);
  if (keys.includes(name)) return name;
  const norm = (s) => s.toLowerCase().replace(/[\s_-]+/g, '');
  return keys.find((k) => norm(k) === norm(name)) || name;
}

function numericValues(videos, field) {
  return videos.map((v) => parseFloat(v[field])).filter((n) => !isNaN(n));
}

function median(sorted) {
  if (!sorted.length) return null;
  return sorted.length % 2 === 0
    ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
    : sorted[Math.floor(sorted.length / 2)];
}

async function executeJsonTool(toolName, args, jsonChannelData, imageParts = []) {
  const videos = jsonChannelData?.videos || [];
  const availableFields = videos.length ? Object.keys(videos[0]) : [];
  const anchorImg = args?.anchorImageBase64 || (imageParts?.[0]?.data) || null;
  const anchorMime = args?.anchorMimeType || imageParts?.[0]?.mimeType || 'image/png';

  switch (toolName) {
    case 'generateImage': {
      const img = await generateImage(args.prompt, anchorImg, anchorMime);
      if (img.error) return { error: img.error };
      return { _chartType: 'generatedImage', ...img };
    }

    case 'plot_metric_vs_time': {
      const metricField = resolveField(videos, args.metricField);
      const timeField = resolveField(videos, args.timeField || 'publishedAt');
      const vals = numericValues(videos, metricField);
      const times = videos.map((v) => v[timeField]).filter(Boolean);

      if (!vals.length || vals.length !== times.length) {
        return {
          error: `Could not plot. Metric "${metricField}" or time "${timeField}" not found. Available: ${availableFields.join(', ')}`,
        };
      }

      const data = videos
        .filter((v) => v[timeField] && !isNaN(parseFloat(v[metricField])))
        .map((v) => ({
          time: v[timeField],
          value: parseFloat(v[metricField]),
          label: v.title || v[timeField],
        }))
        .sort((a, b) => new Date(a.time) - new Date(b.time));

      return {
        _chartType: 'metricVsTime',
        metricField,
        timeField,
        data,
      };
    }

    case 'play_video': {
      const videoId = args.videoId;
      const title = args.title || 'Video';
      const thumbnailUrl = args.thumbnailUrl || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
      const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
      return {
        _chartType: 'playVideo',
        videoId,
        title,
        thumbnailUrl,
        videoUrl,
      };
    }

    case 'compute_stats_json': {
      const field = resolveField(videos, args.field);
      const vals = numericValues(videos, field);
      if (!vals.length) {
        return {
          error: `No numeric values in "${field}". Available: ${availableFields.join(', ')}`,
        };
      }
      const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
      const sorted = [...vals].sort((a, b) => a - b);
      const variance = vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length;
      const fmt = (n) => +n.toFixed(4);
      return {
        field,
        mean: fmt(mean),
        median: fmt(median(sorted)),
        std: fmt(Math.sqrt(variance)),
        min: Math.min(...vals),
        max: Math.max(...vals),
      };
    }

    default:
      return { error: `Unknown tool: ${toolName}` };
  }
}

module.exports = { JSON_TOOL_DECLARATIONS, IMAGE_TOOL_DECLARATIONS, executeJsonTool };
