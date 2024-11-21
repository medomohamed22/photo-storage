<?php
session_start();
include('config.php');

if (!isset($_SESSION['user_id'])) {
    header("Location: login.php");
    exit();
}

if ($_SERVER['REQUEST_METHOD'] == 'POST' && isset($_FILES['file'])) {
    $file = $_FILES['file'];
    $fileName = $_FILES['file']['name'];
    $fileTmpName = $_FILES['file']['tmp_name'];
    $fileType = $_FILES['file']['type'];
    
    // الحصول على اسم الصورة من المدخل الجديد
    $imageName = $_POST['image_name'];

    if (strpos($fileType, 'image') !== false) {
        $mediaType = 'image';
    } elseif (strpos($fileType, 'video') !== false) {
        $mediaType = 'video';
    } else {
        echo "Invalid file type!";
        exit;
    }

    // مسار حفظ الملف
    $filePath = 'uploads/' . $fileName;
    move_uploaded_file($fileTmpName, $filePath);

    // إدخال البيانات في قاعدة البيانات مع اسم الصورة
    $sql = "INSERT INTO media (user_id, file_name, file_path, file_type, image_name) VALUES (?, ?, ?, ?, ?)";
    $stmt = $pdo->prepare($sql);
    $stmt->execute([$_SESSION['user_id'], $fileName, $filePath, $mediaType, $imageName]);

    echo "File uploaded successfully!";
}
?>

<link rel="stylesheet" href="style.css">

<div class="container">
    <h1>Upload Your File</h1>
    <form method="POST" enctype="multipart/form-data">
    <input type="text" name="image_name" placeholder="Enter Image Name" required><br>

    <!-- زر إضافة الملف -->
    <label for="file" class="file-label">Choose File</label>
    <input type="file" name="file" id="file" required><br>

    <button type="submit" class="btn upload-btn">Upload</button>
</form>

    <a href="view.php" class="btn view-btn">View Uploaded Files</a>
</div>
