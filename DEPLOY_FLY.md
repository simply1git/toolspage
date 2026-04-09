# Fly.io Deployment Guide for Toolspage

## Prerequisites

1. **Install Fly.io CLI**
   - Windows: Download from https://fly.io/docs/hands-on/install-flyctl/ or use:
     ```powershell
     iwr https://fly.io/install.ps1 -useb | iex
     ```
   - Or install via Scoop: `scoop install flyctl`

2. **Create Fly.io Account** (free)
   - Sign up at https://fly.io
   - Get your free $5/month credit

## Deployment Steps

### Step 1: Authenticate with Fly.io
```powershell
flyctl auth login
```

### Step 2: Create Fly App and Volume
```powershell
cd e:\project\toolspage

# Create app (first time only)
flyctl launch
# When prompted:
# - Choose app name: toolspage (or your preferred name)
# - Choose region: iad (US East) or closest to you
# - Do NOT use Postgres/Redis just yet

# Create persistent volume for output files
flyctl volumes create toolspage_data --size 10
```

### Step 3: Configure Environment Variables (if needed)
```powershell
# Set API key if you have one configured
flyctl secrets set API_KEY=your_key_here

# Or set other config
flyctl secrets set CORS_ALLOW_ALL=true
flyctl secrets set MEDIA_URL_INGEST_ENABLED=true
```

### Step 4: Deploy
```powershell
flyctl deploy
```

### Step 5: Monitor Deployment
```powershell
# Watch logs
flyctl logs

# Check app status
flyctl status

# View app info
flyctl info
```

## After Deployment

Your app will be live at: `https://toolspage.fly.dev` (or your chosen app name)

### Test the Deployment
```powershell
# Test the API
flyctl open /manifest.json

# Or use PowerShell
Invoke-WebRequest https://toolspage.fly.dev/manifest.json
```

## Free Tier Resource Limits

- **CPU**: Shared 1x (0.25 vCPU) - auto-stops when idle
- **Memory**: 512MB
- **Storage**: 10GB persistent volume (included in free tier)
- **Bandwidth**: Limited but generous for normal use
- **Monthly**: $5 free credit covers your setup

## Scaling Up (if needed)

If you run out of resources:
```powershell
# Increase machine size
flyctl machines update <machine_id> --memory 1024

# Add more machines for parallel processing
flyctl machines create
```

## Scaling Down (to save credits)

If you want to use even less:
```powershell
# Use micro VM instead
flyctl scale vm shared-cpu-1x --memory 256
```

## Monitoring & Maintenance

```powershell
# Check resource usage
flyctl status
flyctl logs

# Restart app
flyctl restart

# Redeploy with code changes
flyctl deploy
```

## Troubleshooting

1. **App won't start**: Check logs with `flyctl logs`
2. **Out of memory**: Reduce memory or optimize code
3. **Build fails**: Verify Dockerfile is in project root
4. **Deploy fails**: Re-run `flyctl deploy` or check region availability

## Next Steps

Once deployed:
1. Open https://toolspage.fly.dev in your browser
2. Test downloading a video/playlist
3. Monitor logs to ensure ffmpeg/yt-dlp work correctly
4. Adjust settings in `fly.toml` as needed
