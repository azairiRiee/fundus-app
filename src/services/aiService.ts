export async function analyzeFundus(imageUrl: string) {

    const imageResponse = await fetch(imageUrl);

    const imageBlob = await imageResponse.blob();

    const formData = new FormData();

    formData.append("file", imageBlob);

    const apiResponse = await fetch(
    "http://localhost:8000/predict",
    {
        method: "POST",
        body: formData,
    });

    if (!apiResponse.ok) {
        throw new Error("AI analysis failed.");
    }

    const result = await apiResponse.json();

    return result;

}