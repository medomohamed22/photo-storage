<?php
session_start();
include('config.php');

// التحقق من تسجيل الدخول
if (!isset($_SESSION['user_id'])) {
    header("Location: login.php");
    exit();
}

// التحقق من وجود معرف الملف في الرابط
if (isset($_GET['id'])) {
    $file_id = $_GET['id'];

    // جلب بيانات الملف من قاعدة البيانات باستخدام المعرف
    $sql = "SELECT * FROM media WHERE id = ? AND user_id = ?";
    $stmt = $pdo->prepare($sql);
    $stmt->execute([$file_id, $_SESSION['user_id']]);
    $file = $stmt->fetch();

    if ($file) {
        // حذف الملف من المجلد
        $file_path = "uploads/" . $file['file_name'];
        if (file_exists($file_path)) {
            unlink($file_path);  // حذف الملف من الخادم
        }

        // حذف الملف من قاعدة البيانات
        $sql_delete = "DELETE FROM media WHERE id = ?";
        $stmt_delete = $pdo->prepare($sql_delete);
        $stmt_delete->execute([$file_id]);

        // إعادة توجيه المستخدم إلى صفحة عرض الملفات بعد الحذف
        header("Location: view.php");
        exit();
    } else {
        echo "File not found.";
    }
} else {
    echo "Invalid request.";
}
?>
