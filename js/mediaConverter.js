const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// Convert PNG/JPG images to MP4 videos
async function convertImageToVideo(imagePath) {
    return new Promise((resolve, reject) => {
        const ext = path.extname(imagePath).toLowerCase();
        if (!['.png', '.jpg', '.jpeg'].includes(ext)) {
            resolve({ success: false, error: 'Not a PNG/JPG file' });
            return;
        }

        const outputPath = imagePath.replace(ext, '.mp4');
        const ffmpegPath = path.join(__dirname, '..', 'provider', 'ffmpeg', 'bin', 'ffmpeg.exe');
        
        if (!fs.existsSync(ffmpegPath)) {
            reject(new Error('FFmpeg not found. Please ensure FFmpeg is installed.'));
            return;
        }

        const args = [
            '-y',
            '-f', 'lavfi',
            '-i', 'color=c=black:s=1920x1080:d=5',
            '-i', imagePath,
            '-filter_complex', '[1:v]scale=1720:-1[fg];[0:v][fg]overlay=(main_w-overlay_w)/2:(main_h-overlay_h)/2',
            '-c:v', 'libx264',
            '-pix_fmt', 'yuv420p',
            outputPath
        ];

        console.log(`FFmpeg command: ${ffmpegPath} ${args.join(' ')}`);

        const ffmpegProcess = spawn(ffmpegPath, args);
        let ffmpegOutput = '';
        let ffmpegError = '';

        ffmpegProcess.stdout.on('data', (data) => {
            const output = data.toString();
            console.log(`FFmpeg stdout: ${output.trim()}`);
            ffmpegOutput += output;
        });

        ffmpegProcess.stderr.on('data', (data) => {
            const error = data.toString();
            console.log(`FFmpeg stderr: ${error.trim()}`);
            ffmpegError += error;
        });

        ffmpegProcess.on('close', (code) => {
            if (code === 0) {
                // Delete the original image file
                try {
                    fs.unlinkSync(imagePath);
                    console.log(`Original image file deleted: ${imagePath}`);
                } catch (deleteError) {
                    console.log(`Warning: Could not delete original file: ${deleteError.message}`);
                }
                
                resolve({
                    success: true,
                    message: `Successfully converted ${path.basename(imagePath)} to MP4`,
                    outputPath: outputPath,
                    file: path.basename(imagePath)
                });
            } else {
                console.log(`FFmpeg process exited with code ${code}`);
                console.log('FFmpeg output:', ffmpegOutput);
                console.log('FFmpeg error:', ffmpegError);
                resolve({
                    success: false,
                    error: `FFmpeg conversion failed with code ${code}: ${ffmpegError || 'Unknown error'}`
                });
            }
        });

        ffmpegProcess.on('error', (error) => {
            console.log(`FFmpeg process error: ${error.message}`);
            reject(error);
        });
    });
}

// Convert non-MP4 video formats to MP4
async function convertVideoToMP4(videoPath) {
    return new Promise((resolve, reject) => {
        const ext = path.extname(videoPath).toLowerCase();
        if (!['.mov', '.webm', '.mkv', '.avi', '.wmv'].includes(ext)) {
            resolve({ success: false, error: 'Not a supported non-MP4 video format' });
            return;
        }

        const outputPath = videoPath.substring(0, videoPath.lastIndexOf('.')) + '.mp4';
        const ffmpegPath = path.join(__dirname, '..', 'provider', 'ffmpeg', 'bin', 'ffmpeg.exe');
        
        if (!fs.existsSync(ffmpegPath)) {
            reject(new Error('FFmpeg not found. Please ensure FFmpeg is installed.'));
            return;
        }

        const args = [
            '-y', '-i', videoPath,
            '-c:v', 'libx264',
            '-profile:v', 'baseline',
            '-level', '4.0',
            '-b:v', '4915k',
            '-r', '30',
            '-g', '30',
            '-refs', '1',
            '-pix_fmt', 'yuv420p',
            '-brand', 'mp42',
            '-an',
            outputPath
        ];

        console.log(`FFmpeg command: ${ffmpegPath} ${args.join(' ')}`);

        const ffmpegProcess = spawn(ffmpegPath, args);
        let ffmpegOutput = '';
        let ffmpegError = '';

        ffmpegProcess.stdout.on('data', (data) => {
            const output = data.toString();
            console.log(`FFmpeg stdout: ${output.trim()}`);
            ffmpegOutput += output;
        });

        ffmpegProcess.stderr.on('data', (data) => {
            const error = data.toString();
            console.log(`FFmpeg stderr: ${error.trim()}`);
            ffmpegError += error;
        });

        ffmpegProcess.on('close', (code) => {
            if (code === 0) {
                // Delete the original video file
                try {
                    fs.unlinkSync(videoPath);
                    console.log(`Original video file deleted: ${videoPath}`);
                } catch (deleteError) {
                    console.log(`Warning: Could not delete original file: ${deleteError.message}`);
                }
                
                resolve({
                    success: true,
                    message: `Successfully converted ${path.basename(videoPath)} to MP4`,
                    outputPath: outputPath,
                    file: path.basename(videoPath)
                });
            } else {
                console.log(`FFmpeg process exited with code ${code}`);
                console.log('FFmpeg output:', ffmpegOutput);
                console.log('FFmpeg error:', ffmpegError);
                resolve({
                    success: false,
                    error: `FFmpeg conversion failed with code ${code}: ${ffmpegError || 'Unknown error'}`
                });
            }
        });

        ffmpegProcess.on('error', (error) => {
            console.log(`FFmpeg process error: ${error.message}`);
            reject(error);
        });
    });
}

// Process all videos and images in PARTNERS_VIDEOS directory
async function processMediaFiles(partnersVideosPath, mainWindow) {
    const results = [];

    if (!fs.existsSync(partnersVideosPath)) {
        console.log('PARTNERS_VIDEOS directory not found');
        return { success: true, results };
    }

    const files = fs.readdirSync(partnersVideosPath);
    
    // Process non-MP4 videos first
    const videoFiles = files.filter(file => {
        const ext = path.extname(file).toLowerCase();
        return ['.mov', '.webm', '.mkv', '.avi', '.wmv'].includes(ext);
    });

    if (videoFiles.length > 0) {
        console.log(`Found ${videoFiles.length} non-MP4 video file(s) to convert: ${videoFiles.join(', ')}`);
        
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('obs-launch-progress', {
                step: 'converting-videos',
                message: `Converting ${videoFiles.length} non-MP4 videos...`
            });
        }

        console.log('=== Video Conversion Results ===');
        for (let i = 0; i < videoFiles.length; i++) {
            const videoFile = videoFiles[i];
            const videoPath = path.join(partnersVideosPath, videoFile);
            
            // Show current file being converted
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('obs-launch-progress', {
                    step: 'converting-videos',
                    message: `Converting ${videoFile} (${i + 1}/${videoFiles.length})...`
                });
            }
            
            console.log(`Converting ${videoFile} (${i + 1}/${videoFiles.length})...`);
            
            try {
                const result = await convertVideoToMP4(videoPath);
                if (result.success) {
                    console.log(`✓ ${result.file || videoFile} → ${path.basename(result.outputPath)} (original deleted)`);
                    results.push({ file: videoFile, success: true, type: 'video' });
                } else {
                    console.log(`✗ ${videoFile} failed: ${result.error}`);
                    results.push({ file: videoFile, success: false, error: result.error, type: 'video' });
                }
            } catch (error) {
                console.log(`✗ ${videoFile} failed: ${error.message}`);
                results.push({ file: videoFile, success: false, error: error.message, type: 'video' });
            }
        }
    } else {
        console.log('No non-MP4 videos found in PARTNERS_VIDEOS directory');
    }

    // Process images
    const imageFiles = files.filter(file => {
        const ext = path.extname(file).toLowerCase();
        return ['.png', '.jpg', '.jpeg'].includes(ext);
    });

    if (imageFiles.length > 0) {
        console.log(`Found ${imageFiles.length} image file(s) to convert: ${imageFiles.join(', ')}`);
        
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('obs-launch-progress', {
                step: 'converting-images',
                message: `Converting ${imageFiles.length} images...`
            });
        }
        
        console.log('=== Image Conversion Results ===');
        for (let i = 0; i < imageFiles.length; i++) {
            const imageFile = imageFiles[i];
            const imagePath = path.join(partnersVideosPath, imageFile);
            
            // Show current file being converted
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('obs-launch-progress', {
                    step: 'converting-images',
                    message: `Converting ${imageFile} (${i + 1}/${imageFiles.length})...`
                });
            }
            
            console.log(`Converting ${imageFile} (${i + 1}/${imageFiles.length})...`);
            
            try {
                const result = await convertImageToVideo(imagePath);
                if (result.success) {
                    console.log(`✓ ${result.file || imageFile} → ${path.basename(result.outputPath)} (original deleted)`);
                    results.push({ file: imageFile, success: true, type: 'image' });
                } else {
                    console.log(`✗ ${imageFile} failed: ${result.error}`);
                    results.push({ file: imageFile, success: false, error: result.error, type: 'image' });
                }
            } catch (error) {
                console.log(`✗ ${imageFile} failed: ${error.message}`);
                results.push({ file: imageFile, success: false, error: error.message, type: 'image' });
            }
        }
    } else {
        console.log('No PNG/JPG images found in PARTNERS_VIDEOS directory');
    }

    return { success: true, results };
}

module.exports = {
    convertImageToVideo,
    convertVideoToMP4,
    processMediaFiles
};