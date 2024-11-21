<?php
session_start();
include('config.php');

if (!isset($_SESSION['user_id'])) {
    header("Location: login.php");
    exit();
}

// جلب الصور أو الفيديوهات من قاعدة البيانات
$sql = "SELECT * FROM media WHERE user_id = ?";
$stmt = $pdo->prepare($sql);
$stmt->execute([$_SESSION['user_id']]);
$files = $stmt->fetchAll();
?>

<link rel="stylesheet" href="style.css">

<div class="container">
    <h1>Your Uploaded Files</h1>

    <!-- زر الرجوع إلى صفحة الرفع -->
    <a href="upload.php" class="btn back-btn">Back to Upload</a>

    <?php if (count($files) > 0): ?>
        <div class="files-grid">
            <?php foreach ($files as $file): ?>
                <div class="file-item">
                    <?php if ($file['file_type'] == 'image'): ?>
                        <img src="uploads/<?php echo $file['file_name']; ?>" alt="<?php echo $file['image_name']; ?>" class="file-image">
                    <?php elseif ($file['file_type'] == 'video'): ?>
                        <video controls class="file-video">
                            <source src="uploads/<?php echo $file['file_name']; ?>" type="video/mp4">
                            Your browser does not support the video tag.
                        </video>
                    <?php endif; ?>

                    <div class="file-actions">
                        <a href="delete.php?id=<?php echo $file['id']; ?>" class="btn delete-btn">Delete</a>
                        <a href="uploads/<?php echo $file['file_name']; ?>" download class="btn download-btn">Download</a>
                    </div>
                </div>
            <?php endforeach; ?>
        </div>
    <?php else: ?>
        <p>No files uploaded yet.</p>
    <?php endif; ?>
</div>
